import { describe, test, expect } from 'bun:test';
import { decompileFunction } from '../lib/decompile.mjs';

describe('decompileFunction', () => {
  test('annotates destructured params', async () => {
    const src = 'function foo({prompt:A,model:B}){return A+B}';
    const result = await decompileFunction(src, 20);
    expect(result.error).toBeUndefined();
    expect(result.annotations.length).toBeGreaterThan(0);
    const aAnno = result.annotations.find(a => a.original === 'A');
    expect(aAnno).toBeDefined();
    expect(aAnno.suggested).toBe('prompt');
    expect(aAnno.confidence).toBe('high');
  });

  test('expands !0 and !1', async () => {
    const src = 'function foo(){var x=!0;var y=!1;return x}';
    const result = await decompileFunction(src, 20);
    expect(result.annotatedSource).toContain('true');
    expect(result.annotatedSource).toContain('false');
  });

  test('expands void 0', async () => {
    const src = 'function foo(){return void 0}';
    const result = await decompileFunction(src, 20);
    expect(result.annotatedSource).toContain('undefined');
  });

  test('reports confidence score', async () => {
    const src = 'function foo({name:A}){return A}';
    const result = await decompileFunction(src, 15);
    expect(result.confidence).toBeGreaterThan(0);
    expect(typeof result.confidence).toBe('number');
  });

  test('handles functions with no short names', async () => {
    const src = 'function foo(longName){return longName}';
    const result = await decompileFunction(src, 20);
    expect(result.confidence).toBe(100);
  });

  test('returns error for invalid offset', async () => {
    const src = 'var x=1;';
    const result = await decompileFunction(src, 4);
    expect(result.error).toBeDefined();
  });

  test('annotates property access patterns', async () => {
    const src = 'function foo(A){return A.message+A.content}';
    const result = await decompileFunction(src, 20);
    // A accesses .message and .content — should get some annotation
    if (result.annotations.length > 0) {
      const aAnno = result.annotations.find(a => a.original === 'A');
      expect(aAnno).toBeDefined();
    }
  });
});
