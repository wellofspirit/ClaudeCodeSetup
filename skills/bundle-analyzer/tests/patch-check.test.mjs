import { describe, test, expect } from 'bun:test';
import { checkPatch } from '../lib/patch-check.mjs';

describe('checkPatch', () => {
  test('returns UNIQUE for single match', () => {
    const src = 'function foo(){return "unique_string"}';
    const result = checkPatch(src, 'unique_string');
    expect(result.status).toBe('UNIQUE');
    expect(result.matchCount).toBe(1);
  });

  test('returns NOT_FOUND for no match', () => {
    const src = 'function foo(){return 1}';
    const result = checkPatch(src, 'nonexistent');
    expect(result.status).toBe('NOT_FOUND');
    expect(result.matchCount).toBe(0);
  });

  test('returns AMBIGUOUS for multiple matches', () => {
    const src = 'var a="dup";var b="dup"';
    const result = checkPatch(src, 'dup');
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.matchCount).toBe(2);
  });

  test('warns about short identifiers', () => {
    const src = 'let D1=foo(A,B)';
    const result = checkPatch(src, 'let D1=foo(A,B)');
    expect(result.warnings.some(w => w.includes('short identifier'))).toBe(true);
  });

  test('generates replacement preview for unique match', () => {
    const src = 'function foo(){return "target"}';
    const result = checkPatch(src, '"target"', '"replaced"');
    expect(result.preview).toBeDefined();
    expect(result.preview.before).toContain('"target"');
    expect(result.preview.after).toContain('"replaced"');
  });

  test('no preview for ambiguous matches', () => {
    const src = 'var a="x";var b="x"';
    const result = checkPatch(src, '"x"', '"y"');
    expect(result.preview).toBeUndefined();
  });

  test('includes context around matches', () => {
    const src = 'aaaa_unique_pattern_bbbb';
    const result = checkPatch(src, 'unique_pattern');
    expect(result.matches[0].context).toContain('aaaa');
    expect(result.matches[0].context).toContain('bbbb');
  });

  test('regex mode finds unique match', () => {
    const src = 'function foo(a,b){return a+b}';
    const result = checkPatch(src, 'function \\w+\\(a,b\\)', undefined, { regex: true });
    expect(result.status).toBe('UNIQUE');
    expect(result.matches[0].matchText).toBe('function foo(a,b)');
  });

  test('regex mode returns AMBIGUOUS for multiple matches', () => {
    const src = 'function foo(){} function bar(){}';
    const result = checkPatch(src, 'function \\w+\\(\\)', undefined, { regex: true });
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.matchCount).toBe(2);
  });

  test('regex mode extracts capture groups', () => {
    const src = 'function foo(x,y){return x+y}';
    const result = checkPatch(src, 'function (\\w+)\\((\\w+),(\\w+)\\)', undefined, { regex: true });
    expect(result.matches[0].captures).toEqual(['foo', 'x', 'y']);
  });

  test('regex mode with %V% expansion', () => {
    const src = 'var $myVar = 123;';
    const result = checkPatch(src, 'var %V% =', undefined, { regex: true });
    expect(result.status).toBe('UNIQUE');
    expect(result.matches[0].matchText).toBe('var $myVar =');
  });

  test('regex mode replacement preview with $N substitution', () => {
    const src = 'function foo(a){return a}';
    const result = checkPatch(src, 'function (\\w+)\\((\\w+)\\)', 'function $1_new($2)', { regex: true });
    expect(result.preview).toBeDefined();
    expect(result.preview.after).toContain('function foo_new(a)');
  });
});
