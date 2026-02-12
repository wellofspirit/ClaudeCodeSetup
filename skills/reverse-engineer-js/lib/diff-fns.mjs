import { walkAST } from './parse.mjs';

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
      removed.push({ name: fn1.name, start: fn1.start, end: fn1.end, size: fn1.end - fn1.start });
    }
  }

  for (const idx of unmatched2Indices) {
    if (!matched2.has(idx)) {
      const fn2 = fp2[idx];
      added.push({ name: fn2.name, start: fn2.start, end: fn2.end, size: fn2.end - fn2.start });
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
