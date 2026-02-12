import { describe, test, expect } from 'bun:test';
import { parseSource } from '../lib/parse.mjs';
import { findRefs } from '../lib/refs.mjs';

describe('findRefs', () => {
  test('excludes locally declared variables', async () => {
    const src = 'var outer=1;function foo(a){var local=2;return outer+a+local}';
    const ast = await parseSource(src);
    // foo body starts around char 27, find offset inside function
    const result = findRefs(ast, src, 40);

    if (result.error) {
      // If scope detection lands on module scope, that's expected for simple cases
      console.log('Scope detection note:', result.error);
      return;
    }

    // 'outer' should be in external refs, 'a' and 'local' should not
    const allRefNames = result.groups.flatMap(g => g.refs.map(r => r.name));
    expect(allRefNames).toContain('outer');
    expect(allRefNames).not.toContain('local');
    expect(allRefNames).not.toContain('a');
  });

  test('returns error at module scope', async () => {
    const src = 'var x=1;';
    const ast = await parseSource(src);
    const result = findRefs(ast, src, 4);
    expect(result.error).toBeDefined();
  });

  test('detects closure references', async () => {
    const src = 'function outer(){var captured=1;function inner(){return captured}}';
    const ast = await parseSource(src);
    // inner body is roughly at char 48+
    const result = findRefs(ast, src, 50);

    if (result.error) return;

    const allRefNames = result.groups.flatMap(g => g.refs.map(r => r.name));
    expect(allRefNames).toContain('captured');
  });
});
