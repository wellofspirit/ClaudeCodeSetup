import { createStateMachine, advanceState, isInCode } from './state-machine.mjs';

export function beautify(src) {
  const sm = createStateMachine();
  const out = [];
  const offsetMap = []; // beautifiedLine → originalCharOffset
  let indent = 0;
  let lineStart = true;
  let currentLine = [];
  let prevNonWS = '';
  let lineOrigOffset = 0;

  function flushLine() {
    const text = currentLine.join('');
    if (text.trim().length > 0) {
      out.push('  '.repeat(Math.max(0, indent)) + text.trimStart());
      offsetMap.push(lineOrigOffset);
    }
    currentLine = [];
    lineStart = true;
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const nextCh = i + 1 < src.length ? src[i + 1] : '';
    advanceState(sm, ch, nextCh, prevNonWS);

    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      prevNonWS = ch;
    }

    if (lineStart) {
      lineOrigOffset = i;
      lineStart = false;
    }

    if (ch === '\n') {
      flushLine();
      continue;
    }

    currentLine.push(ch);

    if (!isInCode(sm.state)) continue;

    if (ch === '{') {
      indent++;
      flushLine();
    } else if (ch === '}') {
      currentLine.pop();
      flushLine();
      indent = Math.max(0, indent - 1);
      currentLine.push('}');
      flushLine();
    } else if (ch === ';') {
      flushLine();
    }
  }

  if (currentLine.length > 0) flushLine();

  return { text: out.join('\n'), offsetMap };
}
