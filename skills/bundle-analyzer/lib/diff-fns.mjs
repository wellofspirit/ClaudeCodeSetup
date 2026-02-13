import { walkAST } from './parse.mjs';
import { beautify } from './beautify.mjs';

// Compare two function maps (from buildFunctionMap with { strings: true }).
// Returns { unchanged, modified, added, removed, shifts }
export function diffFunctions(map1, map2) {
  // Fingerprint each function
  const fp1 = map1.map(fn => ({ ...fn, fingerprint: fingerprint(fn) }));
  const fp2 = map2.map(fn => ({ ...fn, fingerprint: fingerprint(fn) }));

  // Index by fingerprint
  const byFp1 = groupBy(fp1, 'fingerprint');
  const byFp2 = groupBy(fp2, 'fingerprint');

  const unchanged = []; // { v1, v2, shift }
  const modified = [];  // { v1, v2, changes }
  const added = [];     // functions only in map2
  const removed = [];   // functions only in map1

  const matched2 = new Set(); // indices in map2 that have been matched

  // Pass 1: exact fingerprint match → unchanged (just moved)
  for (const fn1 of fp1) {
    const candidates = byFp2.get(fn1.fingerprint);
    if (!candidates || candidates.length === 0) continue;

    // Find best match (closest offset)
    let best = null;
    let bestDist = Infinity;
    for (const fn2 of candidates) {
      if (matched2.has(fn2._idx)) continue;
      const dist = Math.abs(fn2.start - fn1.start);
      if (dist < bestDist) {
        bestDist = dist;
        best = fn2;
      }
    }

    if (best) {
      matched2.add(best._idx);
      fn1._matched = true;
      unchanged.push({
        name: fn1.name,
        v1Start: fn1.start,
        v1End: fn1.end,
        v2Start: best.start,
        v2End: best.end,
        shift: best.start - fn1.start,
      });
    }
  }

  // Pass 2: fuzzy match — same strings + same param count but different structure
  const unmatched1 = fp1.filter(fn => !fn._matched);
  const unmatched2Indices = new Set(fp2.map((_, i) => i).filter(i => !matched2.has(i)));

  for (const fn1 of unmatched1) {
    if (!fn1.strings || fn1.strings.length === 0) continue;

    let bestMatch = null;
    let bestScore = 0;

    for (const idx of unmatched2Indices) {
      const fn2 = fp2[idx];
      if (fn2.paramCount !== fn1.paramCount) continue;
      if (!fn2.strings || fn2.strings.length === 0) continue;

      // Compare string overlap
      const s1 = new Set(fn1.strings);
      const s2 = new Set(fn2.strings);
      const intersection = fn1.strings.filter(s => s2.has(s));
      const union = new Set([...s1, ...s2]);
      const jaccard = intersection.length / union.size;

      if (jaccard > 0.5 && jaccard > bestScore) {
        bestScore = jaccard;
        bestMatch = fn2;
      }
    }

    if (bestMatch) {
      matched2.add(bestMatch._idx);
      fn1._matched = true;
      unmatched2Indices.delete(bestMatch._idx);

      // Compute changes
      const s1 = new Set(fn1.strings);
      const s2 = new Set(bestMatch.strings);
      const addedStrings = bestMatch.strings.filter(s => !s1.has(s));
      const removedStrings = fn1.strings.filter(s => !s2.has(s));
      const sizeDiff = (bestMatch.end - bestMatch.start) - (fn1.end - fn1.start);

      modified.push({
        name: fn1.name,
        v1Start: fn1.start,
        v1End: fn1.end,
        v1Size: fn1.end - fn1.start,
        v2Start: bestMatch.start,
        v2End: bestMatch.end,
        v2Size: bestMatch.end - bestMatch.start,
        shift: bestMatch.start - fn1.start,
        sizeDiff,
        addedStrings,
        removedStrings,
        similarity: bestScore,
      });
    }
  }

  // Pass 3: remaining unmatched
  for (const fn1 of fp1) {
    if (!fn1._matched) {
      removed.push({ name: fn1.name, start: fn1.start, end: fn1.end, size: fn1.end - fn1.start, strings: fn1.strings || [] });
    }
  }

  for (const idx of unmatched2Indices) {
    if (!matched2.has(idx)) {
      const fn2 = fp2[idx];
      added.push({ name: fn2.name, start: fn2.start, end: fn2.end, size: fn2.end - fn2.start, strings: fn2.strings || [] });
    }
  }

  return { unchanged, modified, added, removed };
}

function fingerprint(fn) {
  const parts = [
    fn.paramCount,
    fn.isAsync ? 'A' : '',
    fn.isGenerator ? 'G' : '',
    sizeBin(fn.end - fn.start),
    fn.strings ? fn.strings.join('|') : '',
  ];
  return parts.join(':');
}

function sizeBin(size) {
  // Bin to nearest 10% — e.g., 1000 → 1000, 1050 → 1000, 1150 → 1200
  const bin = Math.round(size / Math.max(1, Math.round(size * 0.1))) * Math.max(1, Math.round(size * 0.1));
  return bin;
}

function groupBy(arr, key) {
  const map = new Map();
  arr.forEach((item, idx) => {
    item._idx = idx;
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  });
  return map;
}

// Produce a unified diff between two function bodies (from modified entry).
// m has v1Start, v1End, v2Start, v2End.
export function diffFunctionBody(src1, m, src2) {
  const body1 = beautify(src1.slice(m.v1Start, m.v1End)).text;
  const body2 = beautify(src2.slice(m.v2Start, m.v2End)).text;
  return unifiedDiff(body1, body2);
}

function unifiedDiff(text1, text2) {
  const lines1 = text1.split('\n');
  const lines2 = text2.split('\n');
  const output = [];
  let i = 0, j = 0;

  // Simple LCS-based diff
  const lcs = computeLCS(lines1, lines2);
  let li = 0, lj = 0, lk = 0;

  for (const [ai, bi] of lcs) {
    // Lines before this match in lines1 are removed
    while (li < ai) {
      output.push(`- ${lines1[li]}`);
      li++;
    }
    // Lines before this match in lines2 are added
    while (lj < bi) {
      output.push(`+ ${lines2[lj]}`);
      lj++;
    }
    output.push(`  ${lines1[ai]}`);
    li = ai + 1;
    lj = bi + 1;
  }

  // Remaining lines
  while (li < lines1.length) {
    output.push(`- ${lines1[li]}`);
    li++;
  }
  while (lj < lines2.length) {
    output.push(`+ ${lines2[lj]}`);
    lj++;
  }

  // Filter to only show changed lines with context
  return compactDiff(output);
}

function computeLCS(a, b) {
  // For large files, use a patience-like approach: match unique lines first
  // For simplicity and correctness, use standard O(n*m) DP for small inputs,
  // and a hash-based greedy approach for large inputs
  if (a.length * b.length < 1_000_000) {
    return lcsDP(a, b);
  }
  return lcsGreedy(a, b);
}

function lcsDP(a, b) {
  const m = a.length, n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack
  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result.reverse();
}

function lcsGreedy(a, b) {
  // Build index of lines in b
  const bIndex = new Map();
  for (let j = 0; j < b.length; j++) {
    if (!bIndex.has(b[j])) bIndex.set(b[j], []);
    bIndex.get(b[j]).push(j);
  }

  const result = [];
  let lastJ = -1;
  for (let i = 0; i < a.length; i++) {
    const positions = bIndex.get(a[i]);
    if (!positions) continue;
    // Find first position > lastJ (binary search)
    let lo = 0, hi = positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[mid] <= lastJ) lo = mid + 1;
      else hi = mid;
    }
    if (lo < positions.length) {
      lastJ = positions[lo];
      result.push([i, lastJ]);
    }
  }
  return result;
}

function compactDiff(lines) {
  const CONTEXT = 3;
  const changed = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i][0] === '+' || lines[i][0] === '-') {
      changed.push(i);
    }
  }

  if (changed.length === 0) return '';

  // Build ranges with context
  const ranges = [];
  let start = Math.max(0, changed[0] - CONTEXT);
  let end = Math.min(lines.length - 1, changed[0] + CONTEXT);

  for (let k = 1; k < changed.length; k++) {
    const cs = Math.max(0, changed[k] - CONTEXT);
    const ce = Math.min(lines.length - 1, changed[k] + CONTEXT);
    if (cs <= end + 1) {
      end = ce;
    } else {
      ranges.push([start, end]);
      start = cs;
      end = ce;
    }
  }
  ranges.push([start, end]);

  const output = [];
  for (const [s, e] of ranges) {
    if (output.length > 0) output.push('...');
    for (let i = s; i <= e; i++) {
      output.push(lines[i]);
    }
  }
  return output.join('\n');
}

// Heuristic: does this string look like embedded code rather than a semantic string?
function looksLikeCode(s) {
  // Very short strings are usually identifiers, not code
  if (s.length < 10) return false;
  // Count code-like characters
  const codeChars = (s.match(/[{};()=>]/g) || []).length;
  const ratio = codeChars / s.length;
  // If >5% of chars are code syntax, it's probably code
  if (ratio > 0.05) return true;
  // Starts with newline + whitespace (template literal code)
  if (/^\n\s/.test(s)) return true;
  // Contains function/arrow/var declarations
  if (/\b(function|=>|var |let |const |return |if\(|else\{|catch\()/.test(s)) return true;
  return false;
}

// Diff two sets of string contents.
// options: { minLength, filterCode, limit }
export function diffStringSets(strings1, strings2, options = {}) {
  const { minLength = 0, filterCode = true, limit = 0 } = options;

  const filter = (s) => {
    if (s.length < minLength) return false;
    if (filterCode && looksLikeCode(s)) return false;
    return true;
  };

  const set1 = new Set(strings1.filter(filter));
  const set2 = new Set(strings2.filter(filter));

  const allOnlyInV1 = [...set1].filter(s => !set2.has(s)).sort();
  const allOnlyInV2 = [...set2].filter(s => !set1.has(s)).sort();
  const common = [...set1].filter(s => set2.has(s)).length;

  return {
    onlyInV1: limit > 0 ? allOnlyInV1.slice(0, limit) : allOnlyInV1,
    onlyInV2: limit > 0 ? allOnlyInV2.slice(0, limit) : allOnlyInV2,
    totalOnlyInV1: allOnlyInV1.length,
    totalOnlyInV2: allOnlyInV2.length,
    commonCount: common,
    v1Total: set1.size,
    v2Total: set2.size,
  };
}

// Auto-categorize diff results by string content patterns.
export function categorizeDiff(result) {
  const categories = [];

  // Version bumps: modified functions where the only string change looks like version/timestamp
  const versionPattern = /^\d+\.\d+|^\d{4}-\d{2}|^v\d/;
  const versionBumps = result.modified.filter(m => {
    const allChanges = [...m.addedStrings, ...m.removedStrings];
    return allChanges.length > 0 && allChanges.every(s => versionPattern.test(s));
  });
  if (versionBumps.length > 0) {
    categories.push({ label: 'Version bumps', description: `${versionBumps.length} functions (version/timestamp strings only)` });
  }

  // Telemetry changes
  const telemetryPattern = /^(tengu_|cli_|telemetry_|analytics_|event_)/;
  const telemetryModified = result.modified.filter(m =>
    [...m.addedStrings, ...m.removedStrings].some(s => telemetryPattern.test(s))
  );
  const telemetryAdded = result.added.filter(fn =>
    fn.strings?.some(s => telemetryPattern.test(s))
  );
  const telemetryRemoved = result.removed.filter(fn =>
    fn.strings?.some(s => telemetryPattern.test(s))
  );
  if (telemetryModified.length + telemetryAdded.length + telemetryRemoved.length > 0) {
    const parts = [];
    if (telemetryModified.length > 0) parts.push(`${telemetryModified.length} modified`);
    if (telemetryAdded.length > 0) parts.push(`${telemetryAdded.length} added`);
    if (telemetryRemoved.length > 0) parts.push(`${telemetryRemoved.length} removed`);
    categories.push({ label: 'Telemetry', description: parts.join(', ') });
  }

  // UI/UX changes: functions with long English text strings
  const uiPattern = /^[A-Z][a-z].*\s.*\s/; // Starts with capital letter, has multiple words
  const uiModified = result.modified.filter(m =>
    [...m.addedStrings, ...m.removedStrings].some(s => s.length > 30 && uiPattern.test(s))
  );
  if (uiModified.length > 0) {
    categories.push({ label: 'UI/UX changes', description: `${uiModified.length} functions with user-facing text changes` });
  }

  // Config changes: functions with config/schema-like strings
  const configPattern = /config|Config|schema|Schema|allowlist|blocklist|whitelist|blacklist|setting/i;
  const configChanges = [...result.modified, ...result.added, ...result.removed].filter(fn => {
    const strings = fn.addedStrings || fn.removedStrings || fn.strings || [];
    return strings.some(s => configPattern.test(s));
  });
  if (configChanges.length > 0) {
    categories.push({ label: 'Config', description: `${configChanges.length} functions with config/schema string changes` });
  }

  // Error handling
  const errorPattern = /error|Error|throw|catch|reject|fail/i;
  const errorChanges = result.modified.filter(m =>
    [...m.addedStrings, ...m.removedStrings].some(s => errorPattern.test(s))
  );
  if (errorChanges.length > 0) {
    categories.push({ label: 'Error handling', description: `${errorChanges.length} modified functions` });
  }

  // Count categorized vs uncategorized
  const categorizedModified = new Set([
    ...versionBumps.map(m => m.name),
    ...telemetryModified.map(m => m.name),
    ...uiModified.map(m => m.name),
    ...errorChanges.map(m => m.name),
  ]);
  const otherModified = result.modified.length - categorizedModified.size;
  const categorizedAdded = new Set(telemetryAdded.map(f => f.name));
  const otherAdded = result.added.length - categorizedAdded.size;
  const categorizedRemoved = new Set(telemetryRemoved.map(f => f.name));
  const otherRemoved = result.removed.length - categorizedRemoved.size;

  const otherParts = [];
  if (otherModified > 0) otherParts.push(`${otherModified} modified`);
  if (otherAdded > 0) otherParts.push(`${otherAdded} added`);
  if (otherRemoved > 0) otherParts.push(`${otherRemoved} removed`);
  if (otherParts.length > 0) {
    categories.push({ label: 'Other', description: otherParts.join(', ') });
  }

  return categories;
}
