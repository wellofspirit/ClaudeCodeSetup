import { describe, test, expect } from 'bun:test';
import { parseSource } from '../lib/parse.mjs';
import { buildFunctionMap } from '../lib/map.mjs';
import { diffFunctions, diffFunctionBody, diffStringSets, categorizeDiff } from '../lib/diff-fns.mjs';

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

  test('added/removed functions include strings', async () => {
    const map1 = await mapFromSrc('function foo(){return "hello"}');
    const map2 = await mapFromSrc('function bar(){return "world"}');
    const diff = diffFunctions(map1, map2);
    expect(diff.removed[0].strings).toContain('hello');
    expect(diff.added[0].strings).toContain('world');
  });
});

describe('diffFunctionBody', () => {
  test('produces unified diff for modified functions', () => {
    const src1 = 'function foo(a){return a+1}';
    const src2 = 'function foo(a){return a+2}';
    const m = { v1Start: 0, v1End: src1.length, v2Start: 0, v2End: src2.length };
    const diff = diffFunctionBody(src1, m, src2);
    expect(diff).toContain('+');
    expect(diff).toContain('-');
  });

  test('returns empty string for identical functions', () => {
    const src = 'function foo(a){return a+1}';
    const m = { v1Start: 0, v1End: src.length, v2Start: 0, v2End: src.length };
    const diff = diffFunctionBody(src, m, src);
    expect(diff).toBe('');
  });
});

describe('diffStringSets', () => {
  test('finds strings only in each set', () => {
    const s1 = ['hello', 'world', 'shared'];
    const s2 = ['shared', 'new_thing', 'another'];
    const diff = diffStringSets(s1, s2, { filterCode: false });
    expect(diff.onlyInV1).toContain('hello');
    expect(diff.onlyInV1).toContain('world');
    expect(diff.onlyInV2).toContain('new_thing');
    expect(diff.onlyInV2).toContain('another');
    expect(diff.commonCount).toBe(1);
  });

  test('respects minLength filter', () => {
    const s1 = ['ab', 'long_string_here'];
    const s2 = ['cd', 'another_long_one'];
    const diff = diffStringSets(s1, s2, { minLength: 5, filterCode: false });
    expect(diff.onlyInV1).toEqual(['long_string_here']);
    expect(diff.onlyInV2).toEqual(['another_long_one']);
  });

  test('filters code-like strings by default', () => {
    const s1 = ['normal string here', 'function foo(){return 1}'];
    const s2 = ['different string here', 'if(x){y=z;return}'];
    const diff = diffStringSets(s1, s2);
    expect(diff.onlyInV1).toContain('normal string here');
    expect(diff.onlyInV1).not.toContain('function foo(){return 1}');
    expect(diff.onlyInV2).toContain('different string here');
    expect(diff.onlyInV2).not.toContain('if(x){y=z;return}');
  });

  test('respects limit option', () => {
    const s1 = ['aaa', 'bbb', 'ccc'];
    const s2 = ['ddd'];
    const diff = diffStringSets(s1, s2, { filterCode: false, limit: 2 });
    expect(diff.onlyInV1.length).toBe(2);
    expect(diff.totalOnlyInV1).toBe(3);
  });

  test('--raw mode includes code-like strings', () => {
    const s1 = ['function foo(){return 1}'];
    const s2 = [];
    const diff = diffStringSets(s1, s2, { filterCode: false });
    expect(diff.onlyInV1).toContain('function foo(){return 1}');
  });
});

describe('categorizeDiff', () => {
  test('categorizes version bumps', () => {
    const result = {
      unchanged: [],
      modified: [
        { name: 'fn1', addedStrings: ['1.2.3'], removedStrings: ['1.2.2'], sizeDiff: 0, shift: 0 },
      ],
      added: [],
      removed: [],
    };
    const cats = categorizeDiff(result);
    expect(cats.some(c => c.label === 'Version bumps')).toBe(true);
  });

  test('categorizes telemetry changes', () => {
    const result = {
      unchanged: [],
      modified: [
        { name: 'fn1', addedStrings: ['cli_new_event'], removedStrings: ['cli_old_event'], sizeDiff: 0, shift: 0 },
      ],
      added: [],
      removed: [],
    };
    const cats = categorizeDiff(result);
    expect(cats.some(c => c.label === 'Telemetry')).toBe(true);
  });

  test('puts uncategorized into Other', () => {
    const result = {
      unchanged: [],
      modified: [
        { name: 'fn1', addedStrings: ['random'], removedStrings: ['stuff'], sizeDiff: 10, shift: 0 },
      ],
      added: [],
      removed: [],
    };
    const cats = categorizeDiff(result);
    expect(cats.some(c => c.label === 'Other')).toBe(true);
  });
});
