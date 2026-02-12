import {
  createStateMachine, advanceState,
  S_NORMAL, S_STRING_SINGLE, S_STRING_DOUBLE, S_TEMPLATE,
} from './state-machine.mjs';
import { findEnclosingFuncName } from './trace-io.mjs';

// Collect all string literals in the source.
// options: { near?: number, nearRange?: number, filter?: string }
export function collectStrings(src, options = {}) {
  const { near, nearRange = 5000, filter } = options;
  const sm = createStateMachine();
  const strings = [];
  let prevNonWS = '';
  let stringStart = -1;
  let stringState = S_NORMAL;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const nextCh = i + 1 < src.length ? src[i + 1] : '';
    const prevState = sm.state;
    advanceState(sm, ch, nextCh, prevNonWS);

    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      prevNonWS = ch;
    }

    // Entering a string
    if (prevState === S_NORMAL && (sm.state === S_STRING_SINGLE || sm.state === S_STRING_DOUBLE || sm.state === S_TEMPLATE)) {
      stringStart = i;
      stringState = sm.state;
    }

    // Exiting a string back to normal
    if (stringStart >= 0 && prevState === stringState && sm.state === S_NORMAL) {
      const content = src.substring(stringStart + 1, i); // strip quotes
      const offset = stringStart;

      // For templates with expressions, skip (they have ${} which complicates things)
      if (stringState === S_TEMPLATE && content.includes('${')) {
        stringStart = -1;
        continue;
      }

      // Apply filters
      if (near !== undefined) {
        if (Math.abs(offset - near) > nearRange) {
          stringStart = -1;
          continue;
        }
      }

      if (filter && !content.includes(filter)) {
        stringStart = -1;
        continue;
      }

      strings.push({ content, offset, length: i - stringStart + 1 });
      stringStart = -1;
    }
  }

  // Optionally enrich with enclosing function name (lazy — only if count is manageable)
  const enriched = strings.map(s => ({
    ...s,
    funcName: strings.length <= 500 ? (findEnclosingFuncName(src, s.offset) || '[anonymous]') : undefined,
  }));

  return enriched;
}
