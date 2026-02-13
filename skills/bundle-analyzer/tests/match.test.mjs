import { describe, test, expect } from 'bun:test';
import { matchPattern } from '../lib/match.mjs';

describe('matchPattern', () => {
  test('returns UNIQUE for single regex match', () => {
    const src = 'function foo(a,b){return a+b}function bar(x){return x}';
    const result = matchPattern(src, 'function (\\w+)\\(a,b\\)');
    expect(result.status).toBe('UNIQUE');
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].captures).toEqual(['foo']);
  });

  test('returns NOT_FOUND for no match', () => {
    const src = 'var x=1;';
    const result = matchPattern(src, 'function (\\w+)');
    expect(result.status).toBe('NOT_FOUND');
    expect(result.matchCount).toBe(0);
  });

  test('returns AMBIGUOUS for multiple matches', () => {
    const src = 'function foo(){} function bar(){}';
    const result = matchPattern(src, 'function (\\w+)\\(\\)');
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.matchCount).toBe(2);
  });

  test('extracts capture groups', () => {
    const src = 'async function zO6(A,q){if((await A()).queuedCommands.length===0)return;}';
    const result = matchPattern(src, 'async function (\\w+)\\((\\w+),(\\w+)\\)');
    expect(result.matches[0].captures).toEqual(['zO6', 'A', 'q']);
  });

  test('supports named capture groups', () => {
    const src = 'function myFunc(x){return x}';
    const result = matchPattern(src, 'function (?<name>\\w+)\\((?<param>\\w+)\\)');
    expect(result.matches[0].namedCaptures).toEqual({ name: 'myFunc', param: 'x' });
  });

  test('expands %V% shorthand', () => {
    const src = 'function $foo(a$b){return a$b}';
    const result = matchPattern(src, 'function (%V%)\\((%V%)\\)');
    expect(result.matches[0].captures).toEqual(['$foo', 'a$b']);
  });

  test('generates replacement preview with $N substitution', () => {
    const src = 'function foo(a){return a}';
    const result = matchPattern(src, 'function (\\w+)\\((\\w+)\\)', 'function $1_new($2)');
    expect(result.preview).toBeDefined();
    expect(result.preview.after).toContain('function foo_new(a)');
  });

  test('no preview without replacement', () => {
    const src = 'function foo(){}';
    const result = matchPattern(src, 'function (\\w+)');
    expect(result.preview).toBeUndefined();
  });

  test('no preview for ambiguous matches', () => {
    const src = 'function foo(){} function bar(){}';
    const result = matchPattern(src, 'function (\\w+)', 'fn $1');
    expect(result.preview).toBeUndefined();
  });

  test('includes expanded pattern in result', () => {
    const result = matchPattern('var x=1', '%V%');
    expect(result.expandedPattern).toBe('[\\w$]+');
  });
});
