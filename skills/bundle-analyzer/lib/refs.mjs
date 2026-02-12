import { walkAST, collectPatternBindings } from './parse.mjs';
import { buildScopeTree } from './scope.mjs';

// Find external variables referenced by the function at charOffset.
export function findRefs(ast, src, charOffset) {
  const { scopes, findScopeAt } = buildScopeTree(ast, src.length);
  const targetScope = findScopeAt(charOffset);

  if (targetScope.type === 'module') {
    return { error: 'Offset is at module scope, not inside a function', targetScope };
  }

  // Find the function AST node that matches our target scope
  const funcNode = findFuncNodeAt(ast, targetScope.start, targetScope.end);
  if (!funcNode) {
    return { error: 'Could not find function AST node at scope', targetScope };
  }

  // Collect all local declarations in this function (including params)
  const localNames = new Set();
  for (const v of targetScope.vars) {
    localNames.add(v.name);
  }

  // Walk the function subtree, collect all Identifier references
  const refs = []; // { name, offset }
  walkAST(funcNode, {
    enter(node) {
      // Skip nested function bodies (their refs are their own)
      if (node !== funcNode && isFunctionNode(node)) {
        return false;
      }

      if (node.type === 'Identifier' && node.value && node.span) {
        // Skip if this is a declaration site (property key, etc.)
        refs.push({ name: node.value, offset: node.span.start });
      }
    },
  });

  // Filter to external refs only
  const externalRefs = refs.filter(r => !localNames.has(r.name));

  // Group by name, look up source scope
  const byName = new Map();
  for (const ref of externalRefs) {
    if (!byName.has(ref.name)) {
      byName.set(ref.name, { name: ref.name, offsets: [], sourceScope: null });
    }
    byName.get(ref.name).offsets.push(ref.offset);
  }

  // Look up each name in parent scopes
  for (const [name, entry] of byName) {
    let scope = targetScope.parent;
    let depth = 1;
    while (scope) {
      const found = scope.vars.find(v => v.name === name);
      if (found) {
        entry.sourceScope = {
          type: scope.type,
          start: scope.start,
          end: scope.end,
          kind: found.kind,
          depth,
        };
        break;
      }
      scope = scope.parent;
      depth++;
    }
    // If not found in any scope, it's a global/built-in
    if (!entry.sourceScope) {
      entry.sourceScope = { type: 'global', start: 0, end: 0, kind: 'global', depth: -1 };
    }
  }

  // Group by source scope
  const byScope = new Map();
  for (const entry of byName.values()) {
    const key = `${entry.sourceScope.type}:${entry.sourceScope.start}`;
    if (!byScope.has(key)) {
      byScope.set(key, { scope: entry.sourceScope, refs: [] });
    }
    byScope.get(key).refs.push(entry);
  }

  const groups = Array.from(byScope.values()).sort((a, b) => a.scope.depth - b.scope.depth);

  const totalRefs = externalRefs.length;
  const uniqueNames = byName.size;

  return { groups, totalRefs, uniqueNames, targetScope };
}

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassMethod' ||
    node.type === 'Method' ||
    node.type === 'MethodProperty';
}

function findFuncNodeAt(ast, start, end) {
  let found = null;
  walkAST(ast, {
    enter(node) {
      if (isFunctionNode(node) && node.span) {
        // Match by start position; SWC spans may differ slightly from scope tree
        if (node.span.start === start ||
            (Math.abs(node.span.start - start) < 10 && Math.abs(node.span.end - end) < 10)) {
          // Prefer exact start match, or closest match
          if (!found || Math.abs(node.span.start - start) < Math.abs(found.span.start - start)) {
            found = node;
          }
        }
      }
    },
  });
  return found;
}
