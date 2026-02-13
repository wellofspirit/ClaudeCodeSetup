import { expandShorthands } from './find.mjs';

// Regex match with patch semantics: captures, uniqueness, replacement preview.
// Returns { status, matchCount, matches[], preview?, expandedPattern }
export function matchPattern(src, pattern, replacement) {
  const expanded = expandShorthands(pattern);
  const re = new RegExp(expanded, 'g');
  const matches = [];

  let m;
  while ((m = re.exec(src)) !== null) {
    const ctxStart = Math.max(0, m.index - 200);
    const ctxEnd = Math.min(src.length, m.index + m[0].length + 200);

    matches.push({
      offset: m.index,
      matchText: m[0],
      context: src.substring(ctxStart, ctxEnd),
      contextOffset: ctxStart,
      captures: m.length > 1 ? [...m].slice(1) : [],
      namedCaptures: m.groups || null,
    });
  }

  let status;
  if (matches.length === 0) status = 'NOT_FOUND';
  else if (matches.length === 1) status = 'UNIQUE';
  else status = 'AMBIGUOUS';

  let preview = undefined;
  if (replacement !== undefined && matches.length === 1) {
    const match = matches[0];
    const before = src.substring(Math.max(0, match.offset - 60), match.offset);
    const afterCtx = src.substring(
      match.offset + match.matchText.length,
      Math.min(src.length, match.offset + match.matchText.length + 60)
    );

    const re2 = new RegExp(expanded);
    const replacedText = match.matchText.replace(re2, replacement);

    preview = {
      before: before + match.matchText + afterCtx,
      after: before + replacedText + afterCtx,
      replacedText,
    };
  }

  return {
    status,
    matchCount: matches.length,
    matches,
    preview,
    expandedPattern: expanded,
  };
}
