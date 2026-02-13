import { describe, test, expect } from 'bun:test';
import {
  findFunctionStart, extractFunction, findMatchingParen, parseParamList, extractSignature, findFunctionStack,
} from '../lib/extract-fn.mjs';

describe('findMatchingParen', () => {
  test('simple parens', () => {
    expect(findMatchingParen('(abc)', 0)).toBe(4);
  });

  test('nested parens', () => {
    expect(findMatchingParen('(a(b)c)', 0)).toBe(6);
  });

  test('no opening paren', () => {
    expect(findMatchingParen('abc', -1)).toBe(-1);
  });
});

describe('parseParamList', () => {
  test('simple params', () => {
    const result = parseParamList('a, b, c');
    expect(result.length).toBe(3);
    expect(result[0].raw).toBe('a');
    expect(result[1].raw).toBe('b');
    expect(result[2].raw).toBe('c');
    expect(result[0].index).toBe(1);
  });

  test('destructured params', () => {
    const result = parseParamList('{x, y}, z');
    expect(result.length).toBe(2);
    expect(result[0].raw).toBe('{x, y}');
    expect(result[1].raw).toBe('z');
  });

  test('empty params', () => {
    const result = parseParamList('');
    expect(result.length).toBe(0);
  });
});

describe('findFunctionStart', () => {
  test('regular function', () => {
    const src = 'var x=1;function foo(a){return a}';
    // function starts at index 8
    const start = findFunctionStart(src, 24); // inside body
    expect(start).toBe(8);
  });

  test('arrow function', () => {
    const src = 'var x=(a)=>{return a};';
    const start = findFunctionStart(src, 12); // inside body
    expect(start).toBe(6); // (a)
  });

  test('async function', () => {
    const src = 'var x=1;async function bar(a){return a}';
    const start = findFunctionStart(src, 30); // inside body
    expect(start).toBe(8); // async
  });

  test('nested functions finds innermost', () => {
    const src = 'function outer(){function inner(){return 1}}';
    const start = findFunctionStart(src, 35); // inside inner body
    expect(start).toBe(17); // inner function start
  });
});

describe('extractFunction', () => {
  test('extracts simple function', () => {
    const src = 'var x=1;function foo(a,b){return a+b}';
    const result = extractFunction(src, 26); // inside body
    expect(result.error).toBeUndefined();
    expect(result.signature).toBe('function foo(a,b)');
    expect(result.start).toBe(8);
    expect(result.end).toBe(37);
    expect(result.paramList.length).toBe(2);
  });

  test('returns error for offset outside function', () => {
    const src = 'var x=1;';
    const result = extractFunction(src, 4);
    expect(result.error).toBeDefined();
  });
});

describe('extractSignature', () => {
  test('extracts function signature', () => {
    const src = 'function foo(a, b){return a+b}';
    const sig = extractSignature(src, 0);
    expect(sig).toBe('function foo(a, b)');
  });

  test('extracts arrow signature', () => {
    const src = '(x,y)=>{return x}';
    const sig = extractSignature(src, 0);
    expect(sig).toBe('(x,y)=>');
  });
});

describe('findFunctionStack', () => {
  test('returns nesting chain for nested functions', () => {
    const src = 'function outer(){function middle(){function inner(){return 1}}}';
    // offset inside inner function body
    const stack = findFunctionStack(src, 50);
    expect(stack.length).toBe(3);
    // Depth 0 should be the innermost (smallest)
    expect(stack[0].signature).toContain('inner');
    expect(stack[1].signature).toContain('middle');
    expect(stack[2].signature).toContain('outer');
  });

  test('returns single entry for non-nested function', () => {
    const src = 'function foo(){return 1}';
    const stack = findFunctionStack(src, 16);
    expect(stack.length).toBe(1);
    expect(stack[0].signature).toContain('foo');
  });

  test('returns empty array for offset outside any function', () => {
    const src = 'var x=1;';
    const stack = findFunctionStack(src, 4);
    expect(stack.length).toBe(0);
  });

  test('stack entries have size info', () => {
    const src = 'function outer(){function inner(){return 1}}';
    const stack = findFunctionStack(src, 35);
    expect(stack.length).toBe(2);
    // Inner should be smaller than outer
    expect(stack[0].size).toBeLessThan(stack[1].size);
  });
});
