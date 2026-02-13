import { findFunctionStart, extractSignature } from './extract-fn.mjs';

export function expandShorthands(pattern) {
  return pattern
    .replace(/%V%/g, '[\\w$]+')
    .replace(/%S%/g, '"(?:[^"\\\\\\\\]|\\\\\\\\.)*"');
}

// Search for pattern in source, return matches grouped by enclosing function.
// options: { regex: boolean, captures: boolean, near: number }
export function findInFunctions(src, pattern, options = {}) {
  const matches = [];

  if (options.regex) {
    const expanded = expandShorthands(pattern);
    const re = new RegExp(expanded, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const entry = { offset: m.index, matchText: m[0] };
      if (options.captures) {
        entry.captures = m.length > 1 ? [...m].slice(1) : [];
        entry.namedCaptures = m.groups || null;
      }
      matches.push(entry);
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

    const grouped = {
      offset: match.offset,
      matchText: match.matchText,
      context,
      contextOffset: ctxStart,
    };
    if (match.captures) grouped.captures = match.captures;
    if (match.namedCaptures) grouped.namedCaptures = match.namedCaptures;
    groups.get(key).matches.push(grouped);
  }

  let groupList = Array.from(groups.values()).sort((a, b) => a.funcStart - b.funcStart);

  // Filter by proximity if --near is given
  if (options.near !== undefined) {
    const radius = options.nearRadius || 5000;
    const center = options.near;
    for (const group of groupList) {
      group.matches = group.matches.filter(
        m => Math.abs(m.offset - center) <= radius
      );
    }
    groupList = groupList.filter(g => g.matches.length > 0);
  }

  const totalMatches = groupList.reduce((s, g) => s + g.matches.length, 0);

  return {
    matches,
    groups: groupList,
    totalMatches,
    totalFunctions: groupList.length,
  };
}
