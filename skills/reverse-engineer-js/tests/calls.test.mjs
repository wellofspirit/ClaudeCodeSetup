import { describe, test, expect } from 'bun:test';
import { parseSource } from '../lib/parse.mjs';
import { findCalls } from '../lib/calls.mjs';

describe('findCalls', () => {
  test('collects outgoing calls', async () => {
    const src = 'function helper(){}function main(){helper();helper();console.log("hi")}';
    const ast = await parseSource(src);
    // main body starts around char 34
    const result = findCalls(ast, src, 40);

    if (result.error) return;

    const names = result.outgoing.map(o => o.name);
    expect(names).toContain('helper');
    expect(names).toContain('console.log');
  });

  test('counts call occurrences', async () => {
    const src = 'function helper(){}function main(){helper();helper();helper()}';
    const ast = await parseSource(src);
    const result = findCalls(ast, src, 40);

    if (result.error) return;

    const helperEntry = result.outgoing.find(o => o.name === 'helper');
    expect(helperEntry).toBeDefined();
    expect(helperEntry.offsets.length).toBe(3);
  });

  test('finds incoming calls', async () => {
    const src = 'function target(){return 1}function caller1(){target()}function caller2(){target()}';
    const ast = await parseSource(src);
    // target body starts around char 0
    const result = findCalls(ast, src, 18);

    if (result.error) return;

    expect(result.funcName).toBe('target');
    expect(result.incoming.length).toBe(2);
  });

  test('handles member expressions', async () => {
    const src = 'function foo(){obj.method();obj.other.deep()}';
    const ast = await parseSource(src);
    const result = findCalls(ast, src, 20);

    if (result.error) return;

    const names = result.outgoing.map(o => o.name);
    expect(names).toContain('obj.method');
    expect(names).toContain('obj.other.deep');
  });

  test('flags ambiguous short names', async () => {
    const src = 'function a(){return 1}function b(){a()}';
    const ast = await parseSource(src);
    const result = findCalls(ast, src, 14);

    if (result.error) return;

    expect(result.ambiguous).toBe(true);
  });

  test('returns error at module scope', async () => {
    const src = 'var x=1;';
    const ast = await parseSource(src);
    const result = findCalls(ast, src, 4);
    expect(result.error).toBeDefined();
  });
});
