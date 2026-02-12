import { describe, test, expect } from 'bun:test';
import { parseSource } from '../lib/parse.mjs';
import { buildFunctionMap } from '../lib/map.mjs';

describe('buildFunctionMap', () => {
  test('collects named functions', async () => {
    const src = 'function foo(a,b){return a+b}function bar(){return 1}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map.length).toBe(2);
    expect(map[0].name).toBe('foo');
    expect(map[1].name).toBe('bar');
  });

  test('records param count', async () => {
    const src = 'function foo(a,b,c){}function bar(){}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map[0].paramCount).toBe(3);
    expect(map[1].paramCount).toBe(0);
  });

  test('detects async functions', async () => {
    const src = 'async function foo(){}function bar(){}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map[0].isAsync).toBe(true);
    expect(map[1].isAsync).toBe(false);
  });

  test('detects generator functions', async () => {
    const src = 'function*gen(){}function normal(){}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map[0].isGenerator).toBe(true);
    expect(map[1].isGenerator).toBe(false);
  });

  test('collects arrow functions', async () => {
    const src = 'const foo=(a)=>{return a};const bar=()=>1';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map.length).toBeGreaterThanOrEqual(2);
  });

  test('collects string literals when option enabled', async () => {
    const src = 'function foo(){return "hello"}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src, { strings: true });
    expect(map[0].strings).toContain('hello');
  });

  test('sorts by start offset', async () => {
    const src = 'function b(){return 2}function a(){return 1}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map[0].start).toBeLessThan(map[1].start);
  });

  test('includes signature', async () => {
    const src = 'function foo(x,y){return x+y}';
    const ast = await parseSource(src);
    const map = buildFunctionMap(ast, src);
    expect(map[0].signature).toContain('function foo');
  });
});
