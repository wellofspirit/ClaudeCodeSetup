// State Machine Core — tracks parser state through strings, comments, regex, template literals.

export const S_NORMAL = 0;
export const S_STRING_SINGLE = 1;
export const S_STRING_DOUBLE = 2;
export const S_TEMPLATE = 3;
export const S_REGEX = 4;
export const S_COMMENT_LINE = 5;
export const S_COMMENT_BLOCK = 6;

export function createStateMachine() {
  return { state: S_NORMAL, escaped: false, templateDepth: 0 };
}

// Advance state machine by one character. Returns the new state.
export function advanceState(sm, ch, nextCh, prevNonWS) {
  if (sm.escaped) {
    sm.escaped = false;
    return sm.state;
  }

  if (ch === '\\' && sm.state !== S_COMMENT_LINE && sm.state !== S_COMMENT_BLOCK && sm.state !== S_NORMAL) {
    sm.escaped = true;
    return sm.state;
  }

  switch (sm.state) {
    case S_NORMAL:
      if (ch === "'") { sm.state = S_STRING_SINGLE; break; }
      if (ch === '"') { sm.state = S_STRING_DOUBLE; break; }
      if (ch === '`') { sm.state = S_TEMPLATE; sm.templateDepth = 0; break; }
      if (ch === '/' && nextCh === '/') { sm.state = S_COMMENT_LINE; break; }
      if (ch === '/' && nextCh === '*') { sm.state = S_COMMENT_BLOCK; break; }
      if (ch === '/' && isRegexContext(prevNonWS)) { sm.state = S_REGEX; break; }
      break;

    case S_STRING_SINGLE:
      if (ch === "'") sm.state = S_NORMAL;
      break;

    case S_STRING_DOUBLE:
      if (ch === '"') sm.state = S_NORMAL;
      break;

    case S_TEMPLATE:
      if (ch === '\\') { sm.escaped = true; break; }
      if (ch === '`' && sm.templateDepth === 0) { sm.state = S_NORMAL; break; }
      if (ch === '$' && nextCh === '{') { sm.templateDepth++; break; }
      if (ch === '}' && sm.templateDepth > 0) { sm.templateDepth--; break; }
      break;

    case S_REGEX:
      if (ch === '/') sm.state = S_NORMAL;
      if (ch === '\\') sm.escaped = true;
      break;

    case S_COMMENT_LINE:
      if (ch === '\n') sm.state = S_NORMAL;
      break;

    case S_COMMENT_BLOCK:
      if (ch === '*' && nextCh === '/') sm.state = S_NORMAL;
      break;
  }

  return sm.state;
}

// Characters after which `/` starts a regex (not division)
export function isRegexContext(prevNonWS) {
  if (!prevNonWS) return true;
  return '=(:;,!&|?{[+->~%^'.includes(prevNonWS) || prevNonWS === '\n';
}

export function isInCode(state) {
  return state === S_NORMAL;
}
