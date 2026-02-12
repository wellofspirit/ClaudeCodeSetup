import { walkAST } from './parse.mjs';
import { buildScopeTree } from './scope.mjs';
import { findFunctionStart, extractSignature } from './extract-fn.mjs';

// Show call graph: outgoing calls from function at charOffset, incoming calls to it.
export function findCalls(ast, src, charOffset) {
  const { findScopeAt } = buildScopeTree(ast, src.length);
  const targetScope = findScopeAt(charOffset);

  if (targetScope.type === 'module') {
    return { error: 'Offset is at module scope, not inside a function' };
  }

  // Find the function AST node
  const funcNode = findFuncNodeAt(ast, targetScope.start, targetScope.end);
  if (!funcNode) {
    return { error: 'Could not find function AST node at scope' };
  }

  // Determine our function's name (if any)
  const funcName = getFunctionName(funcNode, ast);

  // --- Outgoing calls ---
  const outgoing = new Map(); // calleeName → { name, offsets[] }

  walkAST(funcNode, {
    enter(node) {
      // Skip nested functions
      if (node !== funcNode && isFunctionNode(node)) return false;

      if (node.type === 'CallExpression' && node.span) {
        const calleeName = getCalleeName(node.callee);
        if (calleeName) {
          if (!outgoing.has(calleeName)) {
            outgoing.set(calleeName, { name: calleeName, offsets: [] });
          }
          outgoing.get(calleeName).offsets.push(node.span.start);
        }
      }
    },
  });

  const outgoingList = Array.from(outgoing.values())
    .sort((a, b) => b.offsets.length - a.offsets.length);

  // --- Incoming calls ---
  const incoming = [];

  if (funcName) {
    // Search entire source for calls to our function name
    const searchPattern = funcName + '(';
    let idx = 0;
    while (true) {
      const found = src.indexOf(searchPattern, idx);
      if (found < 0) break;

      // Skip if this is the function declaration itself
      if (found >= targetScope.start && found <= targetScope.end) {
        idx = found + 1;
        continue;
      }

      const callerStart = findFunctionStart(src, found);
      const callerSig = callerStart >= 0
        ? extractSignature(src, callerStart)
        : '[top-level]';

      // Extract context
      const ctxStart = Math.max(0, found - 40);
      const ctxEnd = Math.min(src.length, found + searchPattern.length + 40);

      incoming.push({
        offset: found,
        callerSignature: callerSig,
        callerStart,
        context: src.substring(ctxStart, ctxEnd),
      });

      idx = found + 1;
    }
  }

  const ambiguous = funcName && funcName.length <= 2;

  return {
    funcName: funcName || '[anonymous]',
    funcStart: targetScope.start,
    funcEnd: targetScope.end,
    outgoing: outgoingList,
    incoming,
    ambiguous,
  };
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
        if (node.span.start === start ||
            (Math.abs(node.span.start - start) < 10 && Math.abs(node.span.end - end) < 10)) {
          if (!found || Math.abs(node.span.start - start) < Math.abs(found.span.start - start)) {
            found = node;
          }
        }
      }
    },
  });
  return found;
}

// Extract a readable callee name from a CallExpression's callee node.
function getCalleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.value;
  if (callee.type === 'MemberExpression') {
    const obj = getCalleeName(callee.object);
    const prop = callee.property?.type === 'Identifier'
      ? callee.property.value
      : callee.property?.type === 'Computed'
        ? '[computed]'
        : String(callee.property?.value ?? '?');
    return obj ? `${obj}.${prop}` : prop;
  }
  if (callee.type === 'CallExpression') {
    // e.g., foo()()
    return getCalleeName(callee.callee) + '()';
  }
  return null;
}

// Try to determine the name of a function node.
function getFunctionName(funcNode, ast) {
  // Named function declaration/expression
  if (funcNode.identifier?.value) return funcNode.identifier.value;

  // Check if it's the value of a variable assignment: const foo = function() {}
  // We search the AST for VariableDeclarator whose init is this node.
  let name = null;
  walkAST(ast, {
    enter(node) {
      if (name) return false;
      if (node.type === 'VariableDeclarator' && node.init === funcNode && node.id?.type === 'Identifier') {
        name = node.id.value;
        return false;
      }
      // KeyValueProperty: { key: function() {} }
      if (node.type === 'KeyValueProperty' && node.value === funcNode && node.key?.type === 'Identifier') {
        name = node.key.value;
        return false;
      }
    },
  });

  return name;
}
