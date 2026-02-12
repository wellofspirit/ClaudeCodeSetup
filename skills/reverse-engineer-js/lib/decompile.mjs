import { walkAST, parseSource } from './parse.mjs';
import { extractFunction } from './extract-fn.mjs';
import { beautify } from './beautify.mjs';

// Decompile a function at charOffset with best-effort variable naming.
// Returns { signature, annotatedSource, annotations[], confidence }
export async function decompileFunction(src, charOffset) {
  // Extract the function
  const extracted = extractFunction(src, charOffset);
  if (extracted.error) return { error: extracted.error };

  const funcSrc = src.substring(extracted.start, extracted.end);

  // Parse just the function (wrap in parens for expression context)
  let ast;
  try {
    ast = await parseSource(`(${funcSrc})`);
  } catch {
    // If wrapping fails, try as a statement
    try {
      ast = await parseSource(funcSrc);
    } catch (e) {
      return { error: `SWC parse failed: ${e.message}`, beautified: extracted.beautified };
    }
  }

  // Collect identifier usage context
  const idContexts = new Map(); // name → { contexts[] }

  walkAST(ast, {
    enter(node) {
      // Destructured param: { key: localName } → localName is key
      if (node.type === 'KeyValuePatternProperty' && node.key?.type === 'Identifier' && node.value?.type === 'Identifier') {
        addContext(idContexts, node.value.value, { type: 'destructured_as', key: node.key.value });
      }

      // Property access: X.prop → X is used with .prop
      if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.property?.type === 'Identifier') {
        addContext(idContexts, node.object.value, { type: 'property_access', prop: node.property.value });
      }

      // Comparison with string: X === "foo" or X.type === "foo"
      if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '==')) {
        if (node.right?.type === 'StringLiteral' && node.left?.type === 'Identifier') {
          addContext(idContexts, node.left.value, { type: 'compared_to', value: node.right.value });
        }
        if (node.left?.type === 'StringLiteral' && node.right?.type === 'Identifier') {
          addContext(idContexts, node.right.value, { type: 'compared_to', value: node.left.value });
        }
      }

      // Function call argument: foo(X) → X is argument
      if (node.type === 'CallExpression' && node.arguments) {
        const calleeName = getCalleeName(node.callee);
        node.arguments.forEach((arg, i) => {
          if (arg?.expression?.type === 'Identifier' || arg?.type === 'Identifier') {
            const name = arg.expression?.value || arg.value;
            if (name) addContext(idContexts, name, { type: 'passed_to', callee: calleeName, argIndex: i });
          }
        });
      }

      // Assignment: let X = someCall() → X holds result of someCall
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
        const initDesc = describeInit(node.init);
        if (initDesc) {
          addContext(idContexts, node.id.value, { type: 'assigned_from', desc: initDesc });
        }
      }
    },
  });

  // Generate annotations
  const annotations = [];
  let annotatedCount = 0;
  let totalSingleLetter = 0;

  for (const [name, ctx] of idContexts) {
    if (name.length > 3) continue; // only annotate short names
    totalSingleLetter++;

    const suggestion = inferName(name, ctx.contexts);
    if (suggestion) {
      annotatedCount++;
      annotations.push({
        original: name,
        suggested: suggestion,
        confidence: ctx.contexts[0]?.type === 'destructured_as' ? 'high' : 'medium',
        reasoning: ctx.contexts.map(c => contextToString(c)).join('; '),
      });
    }
  }

  // Apply annotations to beautified source as inline comments
  let { text: beautified } = beautify(funcSrc);

  // Build annotation map for quick lookup
  const annoMap = new Map(annotations.map(a => [a.original, a]));

  // Add inline comments after variable declarations and destructured params
  const lines = beautified.split('\n');
  const annotatedLines = lines.map(line => {
    // Check for destructured params: key:localVar
    for (const [orig, anno] of annoMap) {
      // Pattern: `:X,` or `:X}` or `let X=` or `const X=` or `var X=`
      const patterns = [
        new RegExp(`:${escapeRegex(orig)}([,}\\s])`, 'g'),
        new RegExp(`\\b(let|const|var)\\s+${escapeRegex(orig)}\\s*=`, 'g'),
      ];

      for (const pat of patterns) {
        if (pat.test(line) && !line.includes(`// ${anno.suggested}`)) {
          return line + `  // ${orig} = ${anno.suggested}`;
        }
      }
    }
    return line;
  });

  // Expand common minification patterns
  const expanded = annotatedLines.map(line => {
    return line
      .replace(/!0(?!\d)/g, 'true /* !0 */')
      .replace(/!1(?!\d)/g, 'false /* !1 */')
      .replace(/\bvoid 0\b/g, 'undefined /* void 0 */');
  });

  const confidence = totalSingleLetter > 0
    ? Math.round((annotatedCount / totalSingleLetter) * 100)
    : 100;

  return {
    signature: extracted.signature,
    start: extracted.start,
    end: extracted.end,
    annotatedSource: expanded.join('\n'),
    annotations,
    confidence,
    totalSingleLetter,
    annotatedCount,
  };
}

function addContext(map, name, context) {
  if (!map.has(name)) map.set(name, { contexts: [] });
  map.get(name).contexts.push(context);
}

function getCalleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.value;
  if (callee.type === 'MemberExpression') {
    const obj = getCalleeName(callee.object);
    const prop = callee.property?.type === 'Identifier' ? callee.property.value : '?';
    return obj ? `${obj}.${prop}` : prop;
  }
  return null;
}

function describeInit(init) {
  if (init.type === 'CallExpression') {
    const name = getCalleeName(init.callee);
    return name ? `${name}()` : 'call';
  }
  if (init.type === 'MemberExpression') {
    return getCalleeName(init) || 'member';
  }
  if (init.type === 'AwaitExpression' && init.argument) {
    return 'await ' + (describeInit(init.argument) || '?');
  }
  if (init.type === 'NewExpression') {
    const name = getCalleeName(init.callee);
    return name ? `new ${name}()` : 'new';
  }
  return null;
}

function inferName(original, contexts) {
  // Priority 1: destructured key name
  const destructured = contexts.find(c => c.type === 'destructured_as');
  if (destructured) return destructured.key;

  // Priority 2: assignment source
  const assigned = contexts.find(c => c.type === 'assigned_from');
  if (assigned) return camelCase(assigned.desc);

  // Priority 3: property accesses (use most common property as hint)
  const props = contexts.filter(c => c.type === 'property_access').map(c => c.prop);
  if (props.length > 0) {
    const counts = {};
    for (const p of props) counts[p] = (counts[p] || 0) + 1;
    const topProp = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return `${original}_has_${topProp}`;
  }

  // Priority 4: comparison values
  const compared = contexts.find(c => c.type === 'compared_to');
  if (compared) return `${original}_is_${camelCase(compared.value)}`;

  return null;
}

function camelCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 20);
}

function contextToString(ctx) {
  switch (ctx.type) {
    case 'destructured_as': return `destructured from .${ctx.key}`;
    case 'property_access': return `accesses .${ctx.prop}`;
    case 'compared_to': return `compared to "${ctx.value}"`;
    case 'passed_to': return `passed to ${ctx.callee}(arg${ctx.argIndex})`;
    case 'assigned_from': return `assigned from ${ctx.desc}`;
    default: return ctx.type;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
