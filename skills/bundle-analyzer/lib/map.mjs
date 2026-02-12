import { walkAST } from './parse.mjs';

// Build a function index from an SWC AST.
// options: { strings: boolean }
export function buildFunctionMap(ast, src, options = {}) {
  const functions = [];

  walkAST(ast, {
    enter(node) {
      if (!isFunctionNode(node) || !node.span) return;

      const entry = {
        name: inferName(node),
        start: node.span.start,
        end: node.span.end,
        paramCount: getParamCount(node),
        isAsync: !!node.async || !!(node.function?.async),
        isGenerator: !!node.generator || !!(node.function?.generator),
        signature: src.substring(node.span.start, Math.min(node.span.start + 120, node.span.end)).replace(/\n/g, ' '),
      };

      if (options.strings) {
        entry.strings = collectStringLiterals(node);
      }

      functions.push(entry);
    },
  });

  functions.sort((a, b) => a.start - b.start);
  return functions;
}

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassMethod' ||
    node.type === 'Method' ||
    node.type === 'MethodProperty';
}

function inferName(node) {
  // Named declaration/expression
  if (node.identifier?.value) return node.identifier.value;

  // Class method key
  if (node.key) {
    if (node.key.type === 'Identifier') return node.key.value;
    if (node.key.value) return String(node.key.value);
  }

  return '<anonymous>';
}

function getParamCount(node) {
  const params = node.params || node.function?.params;
  return params ? params.length : 0;
}

function collectStringLiterals(funcNode) {
  const strings = new Set();

  walkAST(funcNode, {
    enter(node) {
      if (node.type === 'StringLiteral' && node.value) {
        strings.add(node.value);
      }
      if (node.type === 'TemplateLiteral' && node.quasis) {
        for (const quasi of node.quasis) {
          if (quasi.raw) strings.add(quasi.raw);
          if (quasi.cooked) strings.add(quasi.cooked);
        }
      }
    },
  });

  return [...strings].sort();
}
