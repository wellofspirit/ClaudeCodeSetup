import { walkAST, collectPatternBindings } from './parse.mjs';

// Build a scope tree from an SWC AST.
// Returns { scopes, findScopeAt(offset) }
export function buildScopeTree(ast, srcLength) {
  const scopes = [];
  const scopeStack = [{ type: 'module', start: 0, end: srcLength, vars: [], parent: null }];
  scopes.push(scopeStack[0]);

  function currentScope() {
    return scopeStack[scopeStack.length - 1];
  }

  function pushScope(type, span) {
    const scope = { type, start: span.start, end: span.end, vars: [], parent: currentScope() };
    scopes.push(scope);
    scopeStack.push(scope);
    return scope;
  }

  function popScope() {
    scopeStack.pop();
  }

  function addVar(name, kind, offset, scope = currentScope()) {
    scope.vars.push({ name, kind, offset });
  }

  function addPatternBindings(pat, kind, offset, scope = currentScope()) {
    const bindings = collectPatternBindings(pat, kind, offset);
    for (const b of bindings) {
      scope.vars.push(b);
    }
  }

  function walkNode(node) {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression': {
        if (node.identifier?.value) {
          addVar(node.identifier.value, 'function', node.span.start);
        }
        const scope = pushScope('function', node.span);
        if (node.params) {
          for (const param of node.params) {
            addPatternBindings(param.pat || param, 'param', node.span.start, scope);
          }
        }
        if (node.body) walkNode(node.body);
        popScope();
        return;
      }

      case 'ArrowFunctionExpression': {
        const scope = pushScope('arrow', node.span);
        if (node.params) {
          for (const param of node.params) {
            addPatternBindings(param.pat || param, 'param', node.span.start, scope);
          }
        }
        if (node.body) walkNode(node.body);
        popScope();
        return;
      }

      case 'ClassMethod':
      case 'Method': {
        const scope = pushScope('function', node.span);
        if (node.function?.params || node.params) {
          for (const param of (node.function?.params || node.params)) {
            addPatternBindings(param.pat || param, 'param', node.span.start, scope);
          }
        }
        const body = node.function?.body || node.body;
        if (body) walkNode(body);
        popScope();
        return;
      }

      case 'MethodProperty': {
        const scope = pushScope('function', node.span);
        if (node.params) {
          for (const param of node.params) {
            addPatternBindings(param.pat || param, 'param', node.span.start, scope);
          }
        }
        if (node.body) walkNode(node.body);
        popScope();
        return;
      }

      case 'KeyValueProperty': {
        walkChildren(node);
        return;
      }

      case 'ClassDeclaration': {
        if (node.identifier?.value) {
          addVar(node.identifier.value, 'class', node.span.start);
        }
        pushScope('class', node.span);
        walkChildren(node);
        popScope();
        return;
      }

      case 'BlockStatement': {
        const parent = scopeStack[scopeStack.length - 1];
        if (parent && (parent.start === node.span.start || parent.type === 'function' || parent.type === 'arrow')) {
          walkChildren(node);
        } else {
          pushScope('block', node.span);
          walkChildren(node);
          popScope();
        }
        return;
      }

      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        pushScope('for', node.span);
        walkChildren(node);
        popScope();
        return;
      }

      case 'CatchClause': {
        pushScope('catch', node.span);
        if (node.param) {
          addPatternBindings(node.param, 'catch', node.span.start);
        }
        walkChildren(node);
        popScope();
        return;
      }

      case 'VariableDeclaration': {
        const kind = node.kind;
        if (node.declarations) {
          for (const decl of node.declarations) {
            addPatternBindings(decl.id, kind, decl.span.start);
            if (decl.init) walkNode(decl.init);
          }
        }
        return;
      }
    }

    walkChildren(node);
  }

  function walkChildren(node) {
    for (const key of Object.keys(node)) {
      if (key === 'span' || key === 'type') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && item.type) walkNode(item);
        }
      } else if (val && typeof val === 'object' && val.type) {
        walkNode(val);
      }
    }
  }

  walkNode(ast);

  function findScopeAt(offset) {
    let target = scopes[0];
    for (const scope of scopes) {
      if (offset >= scope.start && offset <= scope.end) {
        if (scope.end - scope.start < target.end - target.start) {
          target = scope;
        }
      }
    }
    return target;
  }

  return { scopes, findScopeAt };
}
