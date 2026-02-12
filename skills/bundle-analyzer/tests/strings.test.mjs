import { describe, test, expect } from 'bun:test';
import { collectStrings } from '../lib/strings.mjs';

describe('collectStrings', () => {
  test('collects single-quoted strings', () => {
    const src = "var x='hello';var y='world'";
    const result = collectStrings(src);
    expect(result.length).toBe(2);
    expect(result[0].content).toBe('hello');
    expect(result[1].content).toBe('world');
  });

  test('collects double-quoted strings', () => {
    const src = 'var x="foo";var y="bar"';
    const result = collectStrings(src);
    expect(result.length).toBe(2);
    expect(result[0].content).toBe('foo');
    expect(result[1].content).toBe('bar');
  });

  test('collects template literals without expressions', () => {
    const src = 'var x=`simple template`';
    const result = collectStrings(src);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('simple template');
  });

  test('skips template literals with expressions', () => {
    const src = 'var x=`hello ${name}`';
    const result = collectStrings(src);
    expect(result.length).toBe(0);
  });

  test('records correct offsets', () => {
    const src = "var x='hello'";
    const result = collectStrings(src);
    expect(result[0].offset).toBe(6); // position of opening quote
  });

  test('filters by --near offset', () => {
    const src = "var a='start';var b='middle';var c='end'";
    const result = collectStrings(src, { near: 20, nearRange: 10 });
    // Only 'middle' at offset ~20 should match
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('middle');
  });

  test('filters by --filter pattern', () => {
    const src = "var x='hello world';var y='goodbye'";
    const result = collectStrings(src, { filter: 'hello' });
    expect(result.length).toBe(1);
    expect(result[0].content).toBe('hello world');
  });

  test('handles empty input', () => {
    const result = collectStrings('');
    expect(result.length).toBe(0);
  });

  test('handles escaped quotes', () => {
    const src = "var x='it\\'s fine'";
    const result = collectStrings(src);
    expect(result.length).toBe(1);
    expect(result[0].content).toContain("it\\'s fine");
  });
});
