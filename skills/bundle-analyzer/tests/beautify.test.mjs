import { describe, test, expect } from 'bun:test';
import { beautify } from '../lib/beautify.mjs';

describe('beautify', () => {
  test('splits on semicolons', () => {
    const { text } = beautify('a=1;b=2;c=3');
    const lines = text.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('a=1;');
    expect(lines[1]).toBe('b=2;');
    expect(lines[2]).toBe('c=3');
  });

  test('indents on braces', () => {
    const { text } = beautify('if(x){a=1;b=2}');
    const lines = text.split('\n');
    // { triggers indent++ then flushLine, so 'if(x){' is at indent 1
    expect(lines[0].trim()).toBe('if(x){');
    expect(lines[1].trim()).toBe('a=1;');
    expect(lines[2].trim()).toBe('b=2');
    expect(lines[3].trim()).toBe('}');
    // Verify indentation depth
    expect(lines[1].startsWith('  ')).toBe(true); // indented inside braces
  });

  test('nested braces increase indent', () => {
    const { text } = beautify('a{b{c}d}');
    const lines = text.split('\n');
    expect(lines[0].trim()).toBe('a{');
    expect(lines[1].trim()).toBe('b{');
    expect(lines[2].trim()).toBe('c');
    expect(lines[3].trim()).toBe('}');
    expect(lines[4].trim()).toBe('d');
    expect(lines[5].trim()).toBe('}');
    // b{ is flushed after indent++, c is at same depth as b{
    const indent0 = lines[0].length - lines[0].trimStart().length;
    const indent1 = lines[1].length - lines[1].trimStart().length;
    expect(indent1).toBeGreaterThan(indent0);
  });

  test('preserves strings containing braces', () => {
    const { text } = beautify('x="{";y="}"');
    // Braces inside strings should NOT cause indentation
    expect(text).toContain('x="{";');
  });

  test('returns offset map', () => {
    const { text, offsetMap } = beautify('a=1;b=2');
    expect(offsetMap.length).toBe(2);
    expect(offsetMap[0]).toBe(0); // first line starts at char 0
  });

  test('handles empty input', () => {
    const { text, offsetMap } = beautify('');
    expect(text).toBe('');
    expect(offsetMap.length).toBe(0);
  });
});
