export function findEnclosingFuncName(src, offset) {
  const window = src.substring(Math.max(0, offset - 2000), offset);

  const funcMatch = window.match(/(?:async\s+)?function\s+([\w$]+)\s*\(/g);
  if (funcMatch) {
    const last = funcMatch[funcMatch.length - 1];
    const nameMatch = last.match(/function\s+([\w$]+)/);
    if (nameMatch) return nameMatch[1];
  }

  const assignMatch = window.match(/(?:const|let|var)\s+([\w$]+)\s*=/g);
  if (assignMatch) {
    const last = assignMatch[assignMatch.length - 1];
    const nameMatch = last.match(/([\w$]+)\s*=/);
    if (nameMatch) return nameMatch[1];
  }

  return null;
}

export function traceIO(src, pattern) {
  const writers = [];

  let searchIdx = 0;
  while (true) {
    const idx = src.indexOf(pattern, searchIdx);
    if (idx < 0) break;

    const ctxStart = Math.max(0, idx - 256);
    const ctxEnd = Math.min(src.length, idx + pattern.length + 512);
    const context = src.substring(ctxStart, ctxEnd);
    const relIdx = idx - ctxStart;

    const funcName = findEnclosingFuncName(src, idx);

    let transport = 'UNKNOWN';
    if (context.includes('Buffer.alloc') || context.includes('writeUInt32LE') || context.includes('writeUInt32BE')) {
      transport = 'BINARY (UInt32 length-prefixed)';
    } else if (context.includes('JSON.stringify') && (context.includes('"\\n"') || context.includes("'\\n'") || context.includes('`\\n`') || context.includes('+\"\\n\"'))) {
      transport = 'JSON+NL (newline-delimited JSON)';
    } else if (context.includes('JSON.stringify')) {
      transport = 'JSON (no delimiter detected nearby)';
    } else {
      const afterPattern = context.substring(relIdx);
      if (afterPattern.match(/\(\s*["'`]/)) {
        transport = 'TEXT (raw string)';
      }
    }

    writers.push({
      charOffset: idx,
      funcName: funcName || '[inline/anonymous]',
      transport,
      context: context.substring(Math.max(0, relIdx - 80), relIdx + pattern.length + 200),
    });

    searchIdx = idx + 1;
  }

  const readers = [];
  const readerPatterns = [
    { pattern: 'createInterface', type: 'readline (line-based)' },
    { pattern: "on('data'", type: 'raw stream data event' },
    { pattern: 'on("data"', type: 'raw stream data event' },
    { pattern: 'readUInt32LE', type: 'binary UInt32LE reader' },
    { pattern: 'readUInt32BE', type: 'binary UInt32BE reader' },
    { pattern: "on('line'", type: 'line event listener' },
    { pattern: 'on("line"', type: 'line event listener' },
  ];

  for (const rp of readerPatterns) {
    let si = 0;
    while (true) {
      const idx = src.indexOf(rp.pattern, si);
      if (idx < 0) break;
      const funcName = findEnclosingFuncName(src, idx);
      readers.push({
        charOffset: idx,
        funcName: funcName || '[inline/anonymous]',
        type: rp.type,
      });
      si = idx + 1;
    }
  }

  return { writers, readers };
}
