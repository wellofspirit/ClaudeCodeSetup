import { describe, test, expect } from 'bun:test';
import {
  createStateMachine, advanceState, isInCode, isRegexContext,
  S_NORMAL, S_STRING_SINGLE, S_STRING_DOUBLE, S_TEMPLATE, S_REGEX,
  S_COMMENT_LINE, S_COMMENT_BLOCK,
} from '../lib/state-machine.mjs';

function runStateMachine(src) {
  const sm = createStateMachine();
  const states = [];
  let prevNonWS = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const nextCh = i + 1 < src.length ? src[i + 1] : '';
    advanceState(sm, ch, nextCh, prevNonWS);
    states.push(sm.state);
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prevNonWS = ch;
  }
  return states;
}

describe('state-machine', () => {
  test('starts in NORMAL state', () => {
    const sm = createStateMachine();
    expect(sm.state).toBe(S_NORMAL);
  });

  test('single-quoted string', () => {
    const states = runStateMachine("x='hello'");
    // x=  are normal, ' enters string, hello is string, ' exits
    expect(states[0]).toBe(S_NORMAL); // x
    expect(states[1]).toBe(S_NORMAL); // =
    expect(states[2]).toBe(S_STRING_SINGLE); // '
    expect(states[3]).toBe(S_STRING_SINGLE); // h
    expect(states[7]).toBe(S_STRING_SINGLE); // o
    expect(states[8]).toBe(S_NORMAL); // closing '
  });

  test('double-quoted string', () => {
    const states = runStateMachine('x="hi"');
    expect(states[2]).toBe(S_STRING_DOUBLE); // "
    expect(states[3]).toBe(S_STRING_DOUBLE); // h
    expect(states[5]).toBe(S_NORMAL); // closing "
  });

  test('escaped quote in string', () => {
    const states = runStateMachine("x='it\\'s'");
    // x = ' i t \\ ' s '
    expect(states[2]).toBe(S_STRING_SINGLE); // '
    expect(states[5]).toBe(S_STRING_SINGLE); // \ (escape)
    expect(states[6]).toBe(S_STRING_SINGLE); // ' (escaped, stays in string)
    expect(states[7]).toBe(S_STRING_SINGLE); // s
    expect(states[8]).toBe(S_NORMAL); // closing '
  });

  test('template literal', () => {
    const states = runStateMachine('x=`hello`');
    expect(states[2]).toBe(S_TEMPLATE); // `
    expect(states[3]).toBe(S_TEMPLATE); // h
    expect(states[8]).toBe(S_NORMAL); // closing `
  });

  test('line comment', () => {
    const states = runStateMachine('x=1// comment\ny');
    expect(states[3]).toBe(S_COMMENT_LINE); // first /
    expect(states[4]).toBe(S_COMMENT_LINE); // second /
    expect(states[5]).toBe(S_COMMENT_LINE); // space
    expect(states[13]).toBe(S_NORMAL); // \n exits comment
    expect(states[14]).toBe(S_NORMAL); // y
  });

  test('block comment', () => {
    const states = runStateMachine('x=1/* comment */y');
    expect(states[3]).toBe(S_COMMENT_BLOCK); // /
    expect(states[4]).toBe(S_COMMENT_BLOCK); // *
    expect(states[13]).toBe(S_COMMENT_BLOCK); // * (closing)
    expect(states[14]).toBe(S_NORMAL); // / (closing, transitions to normal)
    expect(states[15]).toBe(S_NORMAL); // y (but consumed the /, so really the / ends at 14)
  });

  test('regex after operator', () => {
    const states = runStateMachine('x=/ab/');
    expect(states[2]).toBe(S_REGEX); // /
    expect(states[3]).toBe(S_REGEX); // a
    expect(states[5]).toBe(S_NORMAL); // closing /
  });

  test('division not treated as regex', () => {
    const states = runStateMachine('x=a/b');
    // After 'a' (identifier), / is division not regex
    expect(states[3]).toBe(S_NORMAL); // /
    expect(states[4]).toBe(S_NORMAL); // b
  });

  test('isInCode', () => {
    expect(isInCode(S_NORMAL)).toBe(true);
    expect(isInCode(S_STRING_SINGLE)).toBe(false);
    expect(isInCode(S_COMMENT_LINE)).toBe(false);
    expect(isInCode(S_TEMPLATE)).toBe(false);
  });

  test('isRegexContext', () => {
    expect(isRegexContext('=')).toBe(true);
    expect(isRegexContext('(')).toBe(true);
    expect(isRegexContext(';')).toBe(true);
    expect(isRegexContext(null)).toBe(true);
    expect(isRegexContext('a')).toBe(false);
    expect(isRegexContext('0')).toBe(false);
  });
});
