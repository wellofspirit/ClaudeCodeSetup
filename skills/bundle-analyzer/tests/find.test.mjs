import { describe, test, expect } from 'bun:test';
import { findInFunctions } from '../lib/find.mjs';

describe('findInFunctions', () => {
  test('finds string matches with function context', () => {
    const src = 'function foo(){var x="hello";return x}function bar(){var y="hello world"}';
    const result = findInFunctions(src, 'hello');
    expect(result.totalMatches).toBe(2);
    expect(result.totalFunctions).toBe(2);
  });

  test('groups multiple matches in same function', () => {
    const src = 'function foo(){var a="cat";var b="cat"}';
    const result = findInFunctions(src, 'cat');
    expect(result.totalMatches).toBe(2);
    expect(result.totalFunctions).toBe(1);
    expect(result.groups[0].matches.length).toBe(2);
  });

  test('regex mode', () => {
    const src = 'function foo(){var x=123;var y=456}';
    const result = findInFunctions(src, '\\d{3}', { regex: true });
    expect(result.totalMatches).toBe(2);
  });

  test('no matches returns empty', () => {
    const src = 'function foo(){return 1}';
    const result = findInFunctions(src, 'nonexistent');
    expect(result.totalMatches).toBe(0);
    expect(result.groups.length).toBe(0);
  });

  test('includes context around match', () => {
    const src = 'function foo(){var x="target_value";return x}';
    const result = findInFunctions(src, 'target_value');
    expect(result.groups[0].matches[0].context).toContain('target_value');
  });
});
