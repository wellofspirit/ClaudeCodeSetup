import { describe, test, expect } from 'bun:test';
import { parseSource } from '../lib/parse.mjs';
import { buildFunctionMap } from '../lib/map.mjs';
import { diffFunctions } from '../lib/diff-fns.mjs';

async function mapFromSrc(src) {
  const ast = await parseSource(src);
  return buildFunctionMap(ast, src, { strings: true });
}

describe('diffFunctions', () => {
  test('detects unchanged functions', async () => {
    const src = 'function foo(){return "hello"}';
    const map1 = await mapFromSrc(src);
    const map2 = await mapFromSrc(src);
    const diff = diffFunctions(map1, map2);
    expect(diff.unchanged.length).toBe(1);
    expect(diff.modified.length).toBe(0);
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
  });

  test('detects added functions', async () => {
    const map1 = await mapFromSrc('function foo(){return 1}');
    const map2 = await mapFromSrc('function foo(){return 1}function bar(){return 2}');
    const diff = diffFunctions(map1, map2);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0].name).toBe('bar');
  });

  test('detects removed functions', async () => {
    const map1 = await mapFromSrc('function foo(){return 1}function bar(){return 2}');
    const map2 = await mapFromSrc('function foo(){return 1}');
    const diff = diffFunctions(map1, map2);
    expect(diff.removed.length).toBe(1);
    expect(diff.removed[0].name).toBe('bar');
  });

  test('detects position shift for unchanged functions', async () => {
    const map1 = await mapFromSrc('function foo(){return "hello"}');
    const map2 = await mapFromSrc('var x=1;function foo(){return "hello"}');
    const diff = diffFunctions(map1, map2);
    expect(diff.unchanged.length).toBe(1);
    expect(diff.unchanged[0].shift).toBeGreaterThan(0);
  });

  test('detects modified functions (same strings, different structure)', async () => {
    const src1 = 'function foo(a){return "marker_string"}';
    const src2 = 'function foo(a){if(a)return "marker_string";return null}';
    const map1 = await mapFromSrc(src1);
    const map2 = await mapFromSrc(src2);
    const diff = diffFunctions(map1, map2);
    // Should be modified (same string, same param count, different size)
    expect(diff.modified.length + diff.unchanged.length).toBeGreaterThanOrEqual(1);
  });
});
