import { createStateMachine, advanceState, isInCode } from './state-machine.mjs';
import { beautify } from './beautify.mjs';

export function findFunctionStart(src, offset) {
  const sm = createStateMachine();
  let prevNonWS = '';
  let pendingFuncStart = -1;
  const funcStack = [];
  let bestFunc = null;

  const scanEnd = Math.min(src.length, offset + 500000);

  for (let j = 0; j < scanEnd; j++) {
    const ch = src[j];
    const nextCh = j + 1 < src.length ? src[j + 1] : '';
    advanceState(sm, ch, nextCh, prevNonWS);

    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      prevNonWS = ch;
    }

    if (!isInCode(sm.state)) continue;

    // Detect function keyword
    if (ch === 'f' && src.substring(j, j + 8) === 'function') {
      const preBuf = src.substring(Math.max(0, j - 10), j);
      const asyncMatch = preBuf.match(/async\s*$/);
      pendingFuncStart = asyncMatch ? j - asyncMatch[0].length : j;
    }

    // Detect async method shorthand
    if (ch === 'a' && src.substring(j, j + 5) === 'async' && j > 0) {
      const after = src.substring(j + 5, j + 100);
      const methodMatch = after.match(/^\s+([\w$]+)\s*\(/);
      if (methodMatch && methodMatch[1] !== 'function') {
        pendingFuncStart = j;
      }
    }

    // Detect arrow function
    if (ch === '=' && nextCh === '>') {
      if (pendingFuncStart < 0) {
        let arrowStart = j - 1;
        while (arrowStart >= 0 && ' \t\n\r'.includes(src[arrowStart])) arrowStart--;
        if (arrowStart >= 0 && src[arrowStart] === ')') {
          let depth = 1;
          arrowStart--;
          while (arrowStart >= 0 && depth > 0) {
            if (src[arrowStart] === ')') depth++;
            if (src[arrowStart] === '(') depth--;
            arrowStart--;
          }
          arrowStart++;
        }
        const preBuf = src.substring(Math.max(0, arrowStart - 10), arrowStart).trimEnd();
        if (preBuf.endsWith('async')) {
          arrowStart = Math.max(0, arrowStart - 10) + preBuf.lastIndexOf('async');
        }
        pendingFuncStart = arrowStart;
      }
    }

    if (ch === '{') {
      funcStack.push({
        sigStart: pendingFuncStart >= 0 ? pendingFuncStart : -1,
        braceOffset: j,
      });
      pendingFuncStart = -1;
    }

    if (ch === '}') {
      const entry = funcStack.pop();
      if (entry && entry.sigStart >= 0) {
        if (offset >= entry.sigStart && offset <= j) {
          if (!bestFunc || (j - entry.sigStart) < (bestFunc.end - bestFunc.sigStart)) {
            bestFunc = { sigStart: entry.sigStart, braceOffset: entry.braceOffset, end: j };
          }
        }
      }
    }
  }

  for (const entry of funcStack) {
    if (entry.sigStart >= 0 && offset >= entry.sigStart) {
      if (!bestFunc || entry.sigStart > bestFunc.sigStart) {
        bestFunc = { sigStart: entry.sigStart, braceOffset: entry.braceOffset, end: -1 };
      }
    }
  }

  return bestFunc ? bestFunc.sigStart : -1;
}

export function extractFunction(src, charOffset) {
  const funcStart = findFunctionStart(src, charOffset);
  if (funcStart < 0) {
    return { error: 'Could not find enclosing function' };
  }

  const sm = createStateMachine();
  let prevNonWS = '';
  let parenDepth = 0;
  let foundParenOpen = false;
  let pastParams = false;
  let braceDepth = 0;
  let foundBodyBrace = false;
  let funcEnd = -1;

  for (let i = funcStart; i < src.length; i++) {
    const ch = src[i];
    const nextCh = i + 1 < src.length ? src[i + 1] : '';
    advanceState(sm, ch, nextCh, prevNonWS);

    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      prevNonWS = ch;
    }

    if (!isInCode(sm.state)) continue;

    if (!pastParams) {
      if (ch === '(') {
        foundParenOpen = true;
        parenDepth++;
      } else if (ch === ')') {
        parenDepth--;
        if (foundParenOpen && parenDepth === 0) {
          pastParams = true;
        }
      }
      continue;
    }

    if (ch === '{') {
      if (!foundBodyBrace) foundBodyBrace = true;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (foundBodyBrace && braceDepth === 0) {
        funcEnd = i + 1;
        break;
      }
    }
  }

  if (funcEnd < 0) {
    return { error: 'Could not find function end (unbalanced braces)' };
  }

  const raw = src.substring(funcStart, funcEnd);

  const parenOpen = raw.indexOf('(');
  const parenClose = findMatchingParen(raw, parenOpen);
  let bodyBraceIdx = -1;
  if (parenClose >= 0) {
    bodyBraceIdx = raw.indexOf('{', parenClose + 1);
  } else {
    bodyBraceIdx = raw.indexOf('{');
  }

  const signature = raw.substring(0, bodyBraceIdx >= 0 ? bodyBraceIdx : raw.indexOf('{')).trim();

  const params = parenOpen >= 0 && parenClose >= 0
    ? raw.substring(parenOpen + 1, parenClose)
    : '(unknown)';

  const paramList = parseParamList(params);
  const { text: beautified } = beautify(raw);

  return {
    signature,
    start: funcStart,
    end: funcEnd,
    length: funcEnd - funcStart,
    params,
    paramList,
    beautified,
  };
}

export function findMatchingParen(s, openIdx) {
  if (openIdx < 0) return -1;
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseParamList(params) {
  const result = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());

  return result.map((p, idx) => ({ index: idx + 1, raw: p }));
}

// Lightweight signature extraction — skips full beautification.
// Returns just the signature string for a function starting at `funcStart`.
export function extractSignature(src, funcStart) {
  const sm = createStateMachine();
  let prevNonWS = '';
  let parenDepth = 0;
  let foundParenOpen = false;

  for (let i = funcStart; i < Math.min(src.length, funcStart + 500); i++) {
    const ch = src[i];
    const nextCh = i + 1 < src.length ? src[i + 1] : '';
    advanceState(sm, ch, nextCh, prevNonWS);
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prevNonWS = ch;
    if (!isInCode(sm.state)) continue;

    if (ch === '(') { foundParenOpen = true; parenDepth++; }
    if (ch === ')') {
      parenDepth--;
      if (foundParenOpen && parenDepth === 0) {
        // Find the opening brace after params
        const afterParams = src.substring(i + 1, Math.min(src.length, i + 20));
        const braceIdx = afterParams.indexOf('{');
        const end = braceIdx >= 0 ? i + 1 + braceIdx : i + 1;
        return src.substring(funcStart, end).trim();
      }
    }
  }
  // Fallback: return first 80 chars
  return src.substring(funcStart, funcStart + 80).trim();
}
