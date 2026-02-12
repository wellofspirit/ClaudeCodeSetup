import { findFunctionStart, extractSignature } from './extract-fn.mjs';

// Search for pattern in source, return matches grouped by enclosing function.
// options: { regex: boolean }
export function findInFunctions(src, pattern, options = {}) {
  const matches = [];

  if (options.regex) {
    const re = new RegExp(pattern, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      matches.push({ offset: m.index, matchText: m[0] });
    }
  } else {
    let idx = 0;
    while (true) {
      const found = src.indexOf(pattern, idx);
      if (found < 0) break;
      matches.push({ offset: found, matchText: pattern });
      idx = found + 1;
    }
  }

  if (matches.length === 0) return { matches: [], groups: [], totalMatches: 0, totalFunctions: 0 };

  // Group by enclosing function
  const groups = new Map(); // funcStart → { signature, funcStart, matches[] }

  for (const match of matches) {
    const funcStart = findFunctionStart(src, match.offset);
    const key = funcStart >= 0 ? funcStart : -1;

    if (!groups.has(key)) {
      const signature = key >= 0
        ? extractSignature(src, key)
        : '[top-level / unknown]';
      groups.set(key, { signature, funcStart: key, matches: [] });
    }

    // Extract ±80 chars context
    const ctxStart = Math.max(0, match.offset - 80);
    const ctxEnd = Math.min(src.length, match.offset + match.matchText.length + 80);
    const context = src.substring(ctxStart, ctxEnd);

    groups.get(key).matches.push({
      offset: match.offset,
      matchText: match.matchText,
      context,
      contextOffset: ctxStart,
    });
  }

  const groupList = Array.from(groups.values()).sort((a, b) => a.funcStart - b.funcStart);

  return {
    matches,
    groups: groupList,
    totalMatches: matches.length,
    totalFunctions: groupList.length,
  };
}
