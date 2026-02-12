import { createStateMachine, advanceState, isInCode } from './state-machine.mjs';

// Pre-flight validation for a patch pattern.
// Returns { status, matches[], warnings[], preview? }
export function checkPatch(src, pattern, replacement) {
  const matches = [];
  let idx = 0;

  while (true) {
    const found = src.indexOf(pattern, idx);
    if (found < 0) break;

    const ctxStart = Math.max(0, found - 200);
    const ctxEnd = Math.min(src.length, found + pattern.length + 200);
    const context = src.substring(ctxStart, ctxEnd);

    matches.push({
      offset: found,
      context,
      contextOffset: ctxStart,
    });

    idx = found + 1;
  }

  // Determine status
  let status;
  if (matches.length === 0) status = 'NOT_FOUND';
  else if (matches.length === 1) status = 'UNIQUE';
  else status = 'AMBIGUOUS';

  // Warnings
  const warnings = [];

  // Check for short identifiers in the pattern
  const shortIds = pattern.match(/\b[A-Za-z_$]{1,3}\b/g);
  if (shortIds) {
    const unique = [...new Set(shortIds)].filter(id => !['var', 'let', 'for', 'if', 'of', 'in', 'do', 'new'].includes(id));
    if (unique.length > 0) {
      warnings.push(`Pattern contains short identifier(s) [${unique.join(', ')}] — may break if minifier renames them`);
    }
  }

  // Check if match is in code context (not string/comment)
  if (matches.length === 1) {
    const inCode = isOffsetInCode(src, matches[0].offset);
    if (inCode) {
      warnings.push(null); // placeholder — we'll use this as "in code context" (good)
    } else {
      warnings.push('Pattern match is inside a string or comment — not in code context');
    }
  }

  // Replacement preview
  let preview = undefined;
  if (replacement !== undefined && matches.length === 1) {
    const m = matches[0];
    const before = src.substring(Math.max(0, m.offset - 60), m.offset);
    const after = src.substring(m.offset + pattern.length, Math.min(src.length, m.offset + pattern.length + 60));
    preview = {
      before: before + pattern + after,
      after: before + replacement + after,
    };
  }

  return {
    status,
    matchCount: matches.length,
    matches,
    warnings: warnings.filter(Boolean),
    preview,
  };
}

function isOffsetInCode(src, offset) {
  // Run state machine up to offset to determine context
  // For large files, only scan from max(0, offset - 50000) with a fresh SM
  // (strings/comments rarely span 50KB)
  const scanStart = Math.max(0, offset - 50000);
  const sm = createStateMachine();
  let prevNonWS = '';

  for (let i = scanStart; i <= offset; i++) {
    const ch = src[i];
    const nextCh = i + 1 < src.length ? src[i + 1] : '';
    advanceState(sm, ch, nextCh, prevNonWS);
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prevNonWS = ch;
  }

  return isInCode(sm.state);
}
