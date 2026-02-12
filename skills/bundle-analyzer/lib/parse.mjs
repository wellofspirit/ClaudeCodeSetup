import { readFileSync } from 'node:fs';

let _swc = null;

async function getSwc() {
  if (_swc) return _swc;
  try {
    _swc = await import('@swc/core');
  } catch {
    throw new Error('@swc/core not installed. Run: cd ~/.claude/skills/reverse-engineer-js && bun install');
  }
  return _swc;
}

export async function parseSource(src) {
  const swc = await getSwc();
  const ast = await swc.parse(src, { syntax: 'ecmascript', target: 'esnext' });
  // SWC accumulates byte offsets across parse() calls within a process.
  // Normalize all spans to 0-based by subtracting the module's base offset.
  const base = ast.span.start;
  if (base !== 0) normalizeSpans(ast, base);
  return ast;
}

function normalizeSpans(node, base) {
  if (!node || typeof node !== 'object') return;
  if (node.span) {
    node.span.start -= base;
    node.span.end -= base;
  }
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object') normalizeSpans(item, base);
      }
    } else if (val && typeof val === 'object') {
      normalizeSpans(val, base);
    }
  }
}

export async function parseFile(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const ast = await parseSource(src);
  return { ast, src };
}

// Generic AST walker. visitor = { enter(node), leave(node) }
// enter/leave can return false to skip children.
export function walkAST(node, visitor) {
  if (!node || typeof node !== 'object') return;

  if (visitor.enter) {
    const result = visitor.enter(node);
    if (result === false) {
      if (visitor.leave) visitor.leave(node);
      return;
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'span' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type) walkAST(item, visitor);
      }
    } else if (val && typeof val === 'object' && val.type) {
      walkAST(val, visitor);
    }
  }

  if (visitor.leave) visitor.leave(node);
}

// Collect variable bindings from destructuring patterns
export function collectPatternBindings(pat, kind, offset) {
  const bindings = [];

  function collect(p) {
    if (!p) return;
    switch (p.type) {
      case 'Identifier':
        bindings.push({ name: p.value, kind, offset });
        break;
      case 'ObjectPattern':
        if (p.properties) {
          for (const prop of p.properties) {
            if (prop.type === 'RestElement') {
              collect(prop.argument);
            } else if (prop.type === 'KeyValuePatternProperty') {
              collect(prop.value);
            } else if (prop.type === 'AssignmentPatternProperty') {
              if (prop.key) bindings.push({ name: prop.key.value, kind: 'destructured', offset });
            } else if (prop.value) {
              collect(prop.value);
            } else if (prop.key?.value) {
              bindings.push({ name: prop.key.value, kind: 'destructured', offset });
            }
          }
        }
        break;
      case 'ArrayPattern':
        if (p.elements) {
          for (const el of p.elements) {
            if (el) collect(el);
          }
        }
        break;
      case 'AssignmentPattern':
        collect(p.left);
        break;
      case 'RestElement':
        collect(p.argument);
        break;
    }
  }

  collect(pat);
  return bindings;
}
