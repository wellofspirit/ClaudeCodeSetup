import { describe, test, expect } from 'bun:test';
import { findInFunctions, expandShorthands } from '../lib/find.mjs';

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

  test('captures mode extracts regex groups', () => {
    const src = 'function foo(a,b){return a+b}';
    const result = findInFunctions(src, 'function (\\w+)\\((\\w+),(\\w+)\\)', { regex: true, captures: true });
    expect(result.totalMatches).toBe(1);
    const m = result.groups[0].matches[0];
    expect(m.captures).toEqual(['foo', 'a', 'b']);
  });

  test('captures mode with named groups', () => {
    const src = 'function myFn(x){return x}';
    const result = findInFunctions(src, 'function (?<name>\\w+)', { regex: true, captures: true });
    expect(result.groups[0].matches[0].namedCaptures).toEqual({ name: 'myFn' });
  });

  test('captures not stored when captures option is false', () => {
    const src = 'function foo(a){return a}';
    const result = findInFunctions(src, 'function (\\w+)', { regex: true });
    expect(result.groups[0].matches[0].captures).toBeUndefined();
  });

  test('expands %V% shorthand in regex mode', () => {
    const src = 'var $foo = bar$baz;';
    const result = findInFunctions(src, 'var %V%', { regex: true });
    expect(result.totalMatches).toBe(1);
    expect(result.groups[0].matches[0].matchText).toBe('var $foo');
  });

  test('near option filters by proximity', () => {
    // Create a source with two matches far apart
    const padding = 'x'.repeat(20000);
    const src = `function foo(){var a="target";${padding}var b="target"}`;
    const result = findInFunctions(src, 'target', { near: 25, nearRadius: 100 });
    expect(result.totalMatches).toBe(1);
  });
});

describe('expandShorthands', () => {
  test('expands %V%', () => {
    expect(expandShorthands('%V%')).toBe('[\\w$]+');
  });

  test('expands multiple %V%', () => {
    expect(expandShorthands('(%V%),(%V%)')).toBe('([\\w$]+),([\\w$]+)');
  });

  test('expands %S%', () => {
    const result = expandShorthands('%S%');
    expect(result).toContain('"');
  });

  test('leaves non-shorthand text alone', () => {
    expect(expandShorthands('hello world')).toBe('hello world');
  });
});
