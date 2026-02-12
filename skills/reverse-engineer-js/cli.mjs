#!/usr/bin/env node
// Minified JS Analyzer — CLI tool for reverse-engineering large minified bundles.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { beautify } from './lib/beautify.mjs';
import { extractFunction } from './lib/extract-fn.mjs';
import { parseFile } from './lib/parse.mjs';
import { buildScopeTree } from './lib/scope.mjs';
import { traceIO } from './lib/trace-io.mjs';
import { findInFunctions } from './lib/find.mjs';
import { findRefs } from './lib/refs.mjs';
import { findCalls } from './lib/calls.mjs';
import { collectStrings } from './lib/strings.mjs';
import { checkPatch } from './lib/patch-check.mjs';
import { buildFunctionMap } from './lib/map.mjs';
import { diffFunctions } from './lib/diff-fns.mjs';
import { decompileFunction } from './lib/decompile.mjs';

const [,, command, ...args] = process.argv;

const HELP = `
Minified JS Analyzer — Reverse-engineering tool for large minified bundles

Usage:
  node $CLI <command> <file> [options]

Commands:
  beautify <file> [--output <path>]        Create readable copy with offset map
  extract-fn <file> <char-offset>          Extract & beautify function at offset
  scope <file> <char-offset> [--all]       List variables in scope at offset
  trace-io <file> <pattern>                Find I/O channel writers and readers
  find <file> <pattern> [--regex]          Search for pattern, grouped by function
  refs <file> <char-offset>                External variables referenced by function
  calls <file> <char-offset>               Call graph (outgoing + incoming)
  strings <file> [--near N] [--filter S]   Index string literals
  patch-check <file> <pattern> [--replacement S]  Validate patch pattern
  map <file> [--json] [--strings]          Build function index
  diff-fns <file1> <file2> [--json]        Compare function maps across versions
  decompile <file> <char-offset>           Best-effort readable decompilation

Examples:
  node tools/minified-js-analyzer/cli.mjs beautify cli.js
  node tools/minified-js-analyzer/cli.mjs extract-fn cli.js 7984321
  node tools/minified-js-analyzer/cli.mjs scope cli.js 7988095
  node tools/minified-js-analyzer/cli.mjs trace-io cli.js "process.stdout.write"
  node tools/minified-js-analyzer/cli.mjs find cli.js "agent_progress"
  node tools/minified-js-analyzer/cli.mjs refs cli.js 7988095
  node tools/minified-js-analyzer/cli.mjs calls cli.js 7984321
  node tools/minified-js-analyzer/cli.mjs strings cli.js --near 7988095
  node tools/minified-js-analyzer/cli.mjs patch-check cli.js "for await(let D1 of"
  node tools/minified-js-analyzer/cli.mjs map cli.js --json --strings
  node tools/minified-js-analyzer/cli.mjs diff-fns old-cli.js new-cli.js
  node tools/minified-js-analyzer/cli.mjs decompile cli.js 7984321
`.trim();

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function readSrc(filePath) {
  console.log(`Reading ${basename(filePath)}...`);
  const src = readFileSync(filePath, 'utf-8');
  console.log(`File size: ${(src.length / 1e6).toFixed(1)} MB`);
  return src;
}

function parseCharOffset(raw) {
  const n = parseInt(raw, 10);
  if (isNaN(n)) {
    console.error('Error: char-offset must be a number');
    process.exit(1);
  }
  return n;
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  switch (command) {
    case 'beautify': {
      const filePath = resolve(args[0]);
      const outputPath = getArg('--output') ? resolve(getArg('--output')) : filePath + '.beautified.js';
      const mapPath = filePath + '.offsetmap.json';

      const src = readSrc(filePath);

      const start = performance.now();
      const { text, offsetMap } = beautify(src);
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);

      writeFileSync(outputPath, text);
      writeFileSync(mapPath, JSON.stringify(offsetMap));

      const lines = text.split('\n').length;
      console.log(`Beautified: ${lines} lines written to ${basename(outputPath)}`);
      console.log(`Offset map: ${offsetMap.length} entries written to ${basename(mapPath)}`);
      console.log(`Time: ${elapsed}s`);
      break;
    }

    case 'extract-fn': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);

      const src = readSrc(filePath);
      console.log(`Extracting function at char offset ${charOffset}...`);
      const result = extractFunction(src, charOffset);

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`\nFunction: ${result.signature}`);
      console.log(`Offset:   ${result.start} → ${result.end} (${result.length} chars)`);
      console.log(`Params:   ${result.paramList.map(p => `${p.raw} (${p.index}${ordinal(p.index)})`).join(', ')}`);
      console.log(`\n${'─'.repeat(80)}\n`);
      console.log(result.beautified);
      break;
    }

    case 'scope': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);

      console.log(`Parsing ${basename(filePath)} with SWC...`);
      const start = performance.now();
      const { ast, src } = await parseFile(filePath);
      const parseTime = ((performance.now() - start) / 1000).toFixed(2);
      console.log(`Parsed in ${parseTime}s\n`);

      const { findScopeAt } = buildScopeTree(ast, src.length);
      const targetScope = findScopeAt(charOffset);

      console.log(`Scope at char ${charOffset} (${targetScope.type}, char ${targetScope.start}–${targetScope.end}):\n`);

      const showAll = args.includes('--all');
      const sections = [];
      let scope = targetScope;
      let depth = 0;

      while (scope) {
        const label = depth === 0
          ? `# Immediate scope (${scope.type}, char ${scope.start}–${scope.end})`
          : `# Closure depth ${depth} (${scope.type}, char ${scope.start}–${scope.end})`;

        if (scope.vars.length > 0) {
          sections.push({ label, vars: scope.vars });
        }
        scope = scope.parent;
        depth++;
      }

      for (const section of sections) {
        console.log(`  ${section.label}`);
        const vars = section.vars;
        const isModuleScope = section.label.includes('module');
        const limit = (!showAll && isModuleScope && vars.length > 30) ? 30 : vars.length;
        for (let vi = 0; vi < limit; vi++) {
          const v = vars[vi];
          console.log(`  ${v.name.padEnd(10)} ${v.kind.padEnd(13)} char ${v.offset}`);
        }
        if (limit < vars.length) {
          console.log(`  ... and ${vars.length - limit} more (use --all to show all)`);
        }
        console.log();
      }

      const total = sections.reduce((sum, s) => sum + s.vars.length, 0);
      console.log(`Total: ${total} variables in scope`);
      break;
    }

    case 'trace-io': {
      const filePath = resolve(args[0]);
      const pattern = args[1];
      if (!pattern) {
        console.error('Error: pattern is required (e.g., "process.stdout.write")');
        process.exit(1);
      }

      const src = readSrc(filePath);
      console.log(`Tracing I/O channel: ${pattern}\n`);
      const { writers, readers } = traceIO(src, pattern);

      console.log(`Writers (${writers.length} found):`);
      for (const w of writers) {
        console.log(`  char ${w.charOffset.toString().padEnd(10)} ${w.funcName.padEnd(20)} ${w.transport}`);
      }

      if (readers.length > 0) {
        console.log(`\nReaders (${readers.length} found):`);
        for (const r of readers) {
          console.log(`  char ${r.charOffset.toString().padEnd(10)} ${r.funcName.padEnd(20)} ${r.type}`);
        }
      }

      const hasBinaryWriter = writers.some(w => w.transport.startsWith('BINARY'));
      const hasLineReader = readers.some(r => r.type.includes('line'));
      if (hasBinaryWriter && hasLineReader) {
        console.log('\nWarning: Protocol mismatch — binary writer(s) found but reader uses line-based protocol');
      }
      break;
    }

    case 'find': {
      const filePath = resolve(args[0]);
      const pattern = args[1];
      if (!pattern) {
        console.error('Error: pattern is required');
        process.exit(1);
      }

      const isRegex = args.includes('--regex');
      const src = readSrc(filePath);

      console.log(`Searching for ${isRegex ? '/' + pattern + '/' : `"${pattern}"`}...\n`);
      const result = findInFunctions(src, pattern, { regex: isRegex });

      if (result.totalMatches === 0) {
        console.log('No matches found.');
        break;
      }

      console.log(`Found ${result.totalMatches} matches in ${result.totalFunctions} functions:\n`);

      for (const group of result.groups) {
        const loc = group.funcStart >= 0 ? ` — char ${group.funcStart}` : '';
        console.log(`  ${group.signature}${loc}`);
        for (const m of group.matches) {
          const ctx = m.context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
          console.log(`    [${m.offset}] ...${ctx}...`);
        }
        console.log();
      }
      break;
    }

    case 'refs': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);

      console.log(`Parsing ${basename(filePath)} with SWC...`);
      const start = performance.now();
      const { ast, src } = await parseFile(filePath);
      const parseTime = ((performance.now() - start) / 1000).toFixed(2);
      console.log(`Parsed in ${parseTime}s\n`);

      const result = findRefs(ast, src, charOffset);

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`External references from function at char ${charOffset}:\n`);

      for (const group of result.groups) {
        const s = group.scope;
        const label = s.type === 'global'
          ? 'From global scope'
          : `From ${s.type} scope (char ${s.start}–${s.end}, depth ${s.depth})`;
        console.log(`  ${label}:`);
        for (const ref of group.refs) {
          const count = ref.offsets.length;
          const word = count === 1 ? 'ref' : 'refs';
          console.log(`    ${ref.name.padEnd(15)} ${(ref.sourceScope.kind || '').padEnd(12)} ${count} ${word} at [${ref.offsets.join(', ')}]`);
        }
        console.log();
      }

      console.log(`Total: ${result.totalRefs} external references, ${result.uniqueNames} unique names`);
      break;
    }

    case 'calls': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);

      console.log(`Parsing ${basename(filePath)} with SWC...`);
      const start = performance.now();
      const { ast, src } = await parseFile(filePath);
      const parseTime = ((performance.now() - start) / 1000).toFixed(2);
      console.log(`Parsed in ${parseTime}s\n`);

      const result = findCalls(ast, src, charOffset);

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`Call graph for ${result.funcName} at char ${result.funcStart}:\n`);

      console.log(`  Outgoing calls (${result.outgoing.length} unique):`);
      for (const call of result.outgoing) {
        const count = call.offsets.length;
        const word = count === 1 ? 'call' : 'calls';
        console.log(`    ${call.name.padEnd(20)} ${count} ${word} at [${call.offsets.join(', ')}]`);
      }

      console.log(`\n  Incoming calls (${result.incoming.length} found):`);
      if (result.ambiguous) {
        console.log(`    Note: "${result.funcName}" is short — results may include false positives`);
      }
      for (const call of result.incoming) {
        const ctx = call.context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        console.log(`    ${call.callerSignature} — char ${call.callerStart}`);
        console.log(`      [${call.offset}] ...${ctx}...`);
      }
      break;
    }

    case 'strings': {
      const filePath = resolve(args[0]);
      const src = readSrc(filePath);

      const near = getArg('--near') ? parseInt(getArg('--near'), 10) : undefined;
      const filter = getArg('--filter');

      const label = near !== undefined ? ` near char ${near}` : '';
      console.log(`Collecting strings${label}...\n`);

      const strings = collectStrings(src, { near, filter });

      if (strings.length === 0) {
        console.log('No strings found.');
        break;
      }

      for (const s of strings) {
        const content = s.content.length > 80 ? s.content.substring(0, 77) + '...' : s.content;
        const func = s.funcName ? `  in ${s.funcName}` : '';
        console.log(`  char ${s.offset.toString().padEnd(10)} ${JSON.stringify(content)}${func}`);
      }

      console.log(`\nFound ${strings.length} strings`);
      break;
    }

    case 'patch-check': {
      const filePath = resolve(args[0]);
      const pattern = args[1];
      if (!pattern) {
        console.error('Error: pattern is required');
        process.exit(1);
      }

      const replacement = getArg('--replacement');
      const src = readSrc(filePath);

      console.log(`Checking pattern: ${JSON.stringify(pattern)}\n`);
      const result = checkPatch(src, pattern, replacement);

      const statusIcon = result.status === 'UNIQUE' ? 'UNIQUE (1 match)' :
        result.status === 'NOT_FOUND' ? 'NOT FOUND (0 matches)' :
        `AMBIGUOUS (${result.matchCount} matches)`;
      console.log(`Status: ${statusIcon}\n`);

      for (const m of result.matches) {
        const ctx = m.context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        console.log(`  Match at char ${m.offset}:`);
        console.log(`    ...${ctx}...\n`);
      }

      if (result.preview) {
        console.log('Replacement preview:');
        console.log(`  - ${result.preview.before.replace(/\n/g, '\\n')}`);
        console.log(`  + ${result.preview.after.replace(/\n/g, '\\n')}\n`);
      }

      if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const w of result.warnings) {
          console.log(`  - ${w}`);
        }
      }

      if (result.status !== 'UNIQUE') process.exit(1);
      break;
    }

    case 'map': {
      const filePath = resolve(args[0]);
      const isJson = args.includes('--json');
      const includeStrings = args.includes('--strings');

      console.log(`Parsing ${basename(filePath)} with SWC...`);
      const start = performance.now();
      const { ast, src } = await parseFile(filePath);
      const parseTime = ((performance.now() - start) / 1000).toFixed(2);
      console.log(`Parsed in ${parseTime}s`);

      const map = buildFunctionMap(ast, src, { strings: includeStrings });

      if (isJson) {
        const outputPath = filePath + '.map.json';
        writeFileSync(outputPath, JSON.stringify(map, null, 2));
        console.log(`Wrote ${map.length} functions to ${basename(outputPath)}`);
      } else {
        console.log(`\nFunction map for ${basename(filePath)} (${(src.length / 1e6).toFixed(1)} MB):\n`);
        for (let i = 0; i < map.length; i++) {
          const fn = map[i];
          const flags = [fn.isAsync ? 'async' : '', fn.isGenerator ? 'gen' : ''].filter(Boolean).join(' ');
          const sig = fn.signature.substring(0, 60);
          console.log(`  #${(i + 1).toString().padEnd(6)} char ${fn.start.toString().padEnd(10)}–${fn.end.toString().padEnd(10)} ${sig.padEnd(62)} ${flags.padEnd(6)} ${fn.paramCount}p`);
        }
        console.log(`\nTotal: ${map.length} functions`);
      }
      break;
    }

    case 'diff-fns': {
      const filePath1 = resolve(args[0]);
      const filePath2 = resolve(args[1]);
      if (!filePath2) {
        console.error('Error: two file paths required');
        process.exit(1);
      }

      const isJson = args.includes('--json');

      console.log(`Parsing ${basename(filePath1)}...`);
      const { ast: ast1, src: src1 } = await parseFile(filePath1);
      console.log(`Parsing ${basename(filePath2)}...`);
      const { ast: ast2, src: src2 } = await parseFile(filePath2);

      const map1 = buildFunctionMap(ast1, src1, { strings: true });
      const map2 = buildFunctionMap(ast2, src2, { strings: true });

      const result = diffFunctions(map1, map2);

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nComparing ${basename(filePath1)} (${(src1.length / 1e6).toFixed(1)} MB, ${map1.length} fns) vs ${basename(filePath2)} (${(src2.length / 1e6).toFixed(1)} MB, ${map2.length} fns):\n`);
        console.log(`  Unchanged: ${result.unchanged.length} functions`);
        console.log(`  Modified:  ${result.modified.length} functions`);
        console.log(`  Added:     ${result.added.length} functions (new in v2)`);
        console.log(`  Removed:   ${result.removed.length} functions (gone from v2)`);

        if (result.modified.length > 0) {
          console.log('\nModified functions:');
          for (const m of result.modified.slice(0, 20)) {
            console.log(`  ${m.name.padEnd(20)} v1: char ${m.v1Start}–${m.v1End} (${m.v1Size}) → v2: char ${m.v2Start}–${m.v2End} (${m.v2Size}) shift: ${m.shift > 0 ? '+' : ''}${m.shift}`);
            if (m.addedStrings.length > 0) console.log(`    + strings: ${m.addedStrings.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}`);
            if (m.removedStrings.length > 0) console.log(`    - strings: ${m.removedStrings.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}`);
          }
          if (result.modified.length > 20) console.log(`  ... and ${result.modified.length - 20} more`);
        }

        // Show offset shifts for unchanged functions
        if (result.unchanged.length > 0) {
          const shifts = result.unchanged.filter(u => u.shift !== 0);
          if (shifts.length > 0) {
            const avgShift = Math.round(shifts.reduce((s, u) => s + u.shift, 0) / shifts.length);
            console.log(`\nAverage offset shift for unchanged functions: ${avgShift > 0 ? '+' : ''}${avgShift}`);
          }
        }
      }
      break;
    }

    case 'decompile': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);

      const src = readSrc(filePath);
      console.log(`Decompiling function at char ${charOffset}...\n`);

      const result = await decompileFunction(src, charOffset);

      if (result.error) {
        console.error(`Error: ${result.error}`);
        if (result.beautified) {
          console.log('\nFallback (beautified only):');
          console.log(result.beautified);
        }
        process.exit(1);
      }

      console.log(`Decompiled: ${result.signature} [${result.start}–${result.end}]`);
      console.log(`Confidence: ${result.confidence}% (${result.annotatedCount}/${result.totalSingleLetter} short names annotated)\n`);

      if (result.annotations.length > 0) {
        console.log('Annotations:');
        for (const a of result.annotations) {
          console.log(`  ${a.original.padEnd(5)} → ${a.suggested.padEnd(20)} [${a.confidence}] ${a.reasoning}`);
        }
        console.log();
      }

      console.log('─'.repeat(80));
      console.log(result.annotatedSource);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
