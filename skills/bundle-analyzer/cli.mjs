#!/usr/bin/env bun
// Minified JS Analyzer — CLI tool for reverse-engineering large minified bundles.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { beautify } from './lib/beautify.mjs';
import { extractFunction, findFunctionStart, extractSignature, findFunctionStack } from './lib/extract-fn.mjs';
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
import { matchPattern } from './lib/match.mjs';

const [,, command, ...args] = process.argv;

const HELP = `
Minified JS Analyzer — Reverse-engineering tool for large minified bundles

Usage:
  bun $CLI <command> <file> [options]

Commands:
  beautify <file> [--output <path>]        Create readable copy with offset map
  slice <file> <offset> [length]           Raw code at offset (default 500 chars)
    [--before N] [--after N] [--beautify]
  extract-fn <file> <char-offset>          Extract & beautify function at offset
    [--stack] [--depth N]
  context <file> <char-offset>             One-shot understanding at offset
  scope <file> <char-offset> [--all]       List variables in scope at offset
  trace-io <file> <pattern>                Find I/O channel writers and readers
  find <file> <pattern> [--regex]          Search for pattern, grouped by function
    [--captures] [--compact] [--near N] [--count] [--limit N]
  match <file> <pattern>                   Regex match with patch semantics
    [--replace S]                          Captures, uniqueness, replacement preview
  refs <file> <char-offset>                External variables referenced by function
  calls <file> <char-offset>               Call graph (outgoing + incoming)
  strings <file> [--near N] [--filter S]   Index string literals
  strings --diff <f1> <f2>                Compare string sets between two files
    [--min-length N] [--limit N] [--raw] [--all]
  patch-check <file> <pattern> [--replacement S] [--regex]  Validate patch pattern
  map <file> [--json] [--strings]          Build function index
  diff-fns <file1> <file2> [options]       Compare function maps across versions
    [--json] [--limit N] [--all] [--name X] [--body]
    [--filter P] [--summary] [--strings-only] [--raw]
  decompile <file> <char-offset>           Best-effort readable decompilation

Shorthands (in regex patterns):
  %V%  →  [\\w$]+   (minified variable name)
  %S%  →  "(?:[^"\\\\]|\\\\.)*"  (double-quoted string)

Examples:
  bun $CLI slice cli.js 7944591 300
  bun $CLI slice cli.js 7944591 --before 100 --after 300 --beautify
  bun $CLI extract-fn cli.js 7944719 --stack
  bun $CLI extract-fn cli.js 7944719 --depth 2
  bun $CLI context cli.js 7944719
  bun $CLI find cli.js "agent_progress"
  bun $CLI find cli.js '(%V%)\\(' --regex --captures
  bun $CLI find cli.js "queuedCommands" --compact --limit 10
  bun $CLI match cli.js 'async function (%V%)\\(' --replace 'async function $1_patched('
  bun $CLI patch-check cli.js "pattern" --regex --replacement "replacement"
  bun $CLI map cli.js --json --strings
  bun $CLI diff-fns old-cli.js new-cli.js
  bun $CLI diff-fns old-cli.js new-cli.js --body --limit 10
  bun $CLI diff-fns old-cli.js new-cli.js --filter "sandbox"
  bun $CLI diff-fns old-cli.js new-cli.js --summary
  bun $CLI strings --diff old-cli.js new-cli.js --min-length 20
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

// Extract positional (non-flag) arguments, skipping flags and their values.
// flagsWithValues: flags that consume the next arg as a value (e.g. '--min-length')
function getPositionalArgs(argList, flagsWithValues = []) {
  const result = [];
  for (let i = 0; i < argList.length; i++) {
    if (argList[i].startsWith('--')) {
      if (flagsWithValues.includes(argList[i])) i++; // skip value
      continue;
    }
    result.push(argList[i]);
  }
  return result;
}

function printStringDiff(diff, name1, name2) {
  const totalV2 = diff.totalOnlyInV2 ?? diff.onlyInV2.length;
  const totalV1 = diff.totalOnlyInV1 ?? diff.onlyInV1.length;

  if (totalV2 > 0) {
    const showing = diff.onlyInV2.length < totalV2 ? `, showing ${diff.onlyInV2.length}` : '';
    console.log(`\nStrings only in ${name2} (${totalV2}${showing}):`);
    for (const s of diff.onlyInV2) {
      const truncated = s.length > 120 ? s.substring(0, 117) + '...' : s;
      console.log(`  + ${JSON.stringify(truncated)}`);
    }
    if (diff.onlyInV2.length < totalV2) {
      console.log(`  ... and ${totalV2 - diff.onlyInV2.length} more (use --all to show all)`);
    }
  }
  if (totalV1 > 0) {
    const showing = diff.onlyInV1.length < totalV1 ? `, showing ${diff.onlyInV1.length}` : '';
    console.log(`\nStrings only in ${name1} (${totalV1}${showing}):`);
    for (const s of diff.onlyInV1) {
      const truncated = s.length > 120 ? s.substring(0, 117) + '...' : s;
      console.log(`  - ${JSON.stringify(truncated)}`);
    }
    if (diff.onlyInV1.length < totalV1) {
      console.log(`  ... and ${totalV1 - diff.onlyInV1.length} more (use --all to show all)`);
    }
  }
  console.log(`\nTotal: +${totalV2} new, -${totalV1} removed (of ${diff.v1Total} / ${diff.v2Total} unique strings)`);
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

    case 'slice': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);
      const beforeN = getArg('--before') ? parseInt(getArg('--before'), 10) : undefined;
      const afterN = getArg('--after') ? parseInt(getArg('--after'), 10) : undefined;
      const doBeautify = args.includes('--beautify');

      let sliceStart, sliceEnd;
      if (beforeN !== undefined || afterN !== undefined) {
        sliceStart = Math.max(0, charOffset - (beforeN || 0));
        sliceEnd = charOffset + (afterN || 0);
      } else {
        const length = args[2] && !args[2].startsWith('-') ? parseInt(args[2], 10) : 500;
        sliceStart = charOffset;
        sliceEnd = charOffset + length;
      }

      const src = readSrc(filePath);
      sliceEnd = Math.min(sliceEnd, src.length);
      let code = src.slice(sliceStart, sliceEnd);
      const label = doBeautify ? ', beautified' : '';

      if (doBeautify) {
        code = beautify(code).text;
      }

      console.log(`\nSlice at char ${sliceStart}–${sliceEnd} (${sliceEnd - sliceStart} chars${label}):\n`);
      console.log('─'.repeat(80));
      console.log(code);
      console.log('─'.repeat(80));
      break;
    }

    case 'extract-fn': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);
      const showStack = args.includes('--stack');
      const depthArg = getArg('--depth');
      const depth = depthArg !== undefined ? parseInt(depthArg, 10) : undefined;

      const src = readSrc(filePath);

      if (showStack) {
        console.log(`Function nesting at char ${charOffset}:\n`);
        const stack = findFunctionStack(src, charOffset);
        if (stack.length === 0) {
          console.log('No enclosing functions found.');
          break;
        }
        for (let i = 0; i < stack.length; i++) {
          const fn = stack[i];
          const sizeStr = fn.size > 0 ? `${fn.size} chars` : 'unknown size';
          const range = fn.end > 0 ? `${fn.sigStart}–${fn.end}` : `${fn.sigStart}–?`;
          console.log(`  Depth ${i}: ${fn.signature}  (${range}, ${sizeStr})`);
        }
        console.log(`\nUse --depth N to extract a specific level.`);
        break;
      }

      if (depth !== undefined) {
        const stack = findFunctionStack(src, charOffset);
        if (depth >= stack.length) {
          console.error(`Error: depth ${depth} out of range (max ${stack.length - 1})`);
          process.exit(1);
        }
        const target = stack[depth];
        const result = extractFunction(src, target.sigStart + 1);
        if (result.error) {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }
        console.log(`\nFunction (depth ${depth}): ${result.signature}`);
        console.log(`Offset:   ${result.start} → ${result.end} (${result.length} chars)`);
        console.log(`Params:   ${result.paramList.map(p => `${p.raw} (${p.index}${ordinal(p.index)})`).join(', ')}`);
        console.log(`\n${'─'.repeat(80)}\n`);
        console.log(result.beautified);
        break;
      }

      console.log(`Extracting function at char offset ${charOffset}...`);
      let result = extractFunction(src, charOffset);

      if (result.error && !args.includes('--no-ast-fallback')) {
        // Fallback to AST-based extraction
        console.log('State-machine extraction failed, trying AST fallback...');
        const { ast } = await parseFile(filePath);
        const fns = buildFunctionMap(ast, src);
        const enclosing = fns.find(fn => fn.start <= charOffset && fn.end >= charOffset);
        if (enclosing) {
          const raw = src.slice(enclosing.start, enclosing.end);
          result = {
            signature: enclosing.signature.substring(0, enclosing.signature.indexOf('{') >= 0 ? enclosing.signature.indexOf('{') : enclosing.signature.length).trim(),
            start: enclosing.start,
            end: enclosing.end,
            length: enclosing.end - enclosing.start,
            paramList: [],
            beautified: beautify(raw).text,
            note: '(extracted via AST fallback)',
          };
        }
      }

      if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      console.log(`\nFunction: ${result.signature}${result.note ? ' ' + result.note : ''}`);
      console.log(`Offset:   ${result.start} → ${result.end} (${result.length} chars)`);
      if (result.paramList?.length > 0) {
        console.log(`Params:   ${result.paramList.map(p => `${p.raw} (${p.index}${ordinal(p.index)})`).join(', ')}`);
      }
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
      const showCaptures = args.includes('--captures');
      const isCompact = args.includes('--compact');
      const isCount = args.includes('--count');
      const nearArg = getArg('--near');
      const limitArg = getArg('--limit');
      const near = nearArg ? parseInt(nearArg, 10) : undefined;
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;

      const src = readSrc(filePath);

      console.log(`Searching for ${isRegex ? '/' + pattern + '/' : `"${pattern}"`}...\n`);
      const result = findInFunctions(src, pattern, {
        regex: isRegex,
        captures: showCaptures,
        near,
      });

      if (result.totalMatches === 0) {
        console.log('No matches found.');
        break;
      }

      console.log(`Found ${result.totalMatches} matches in ${result.totalFunctions} functions:\n`);

      if (isCount) {
        for (const group of result.groups) {
          const loc = group.funcStart >= 0 ? ` — char ${group.funcStart}` : '';
          console.log(`  ${group.signature}${loc}: ${group.matches.length} matches`);
        }
        break;
      }

      let shown = 0;
      for (const group of result.groups) {
        if (limit && shown >= limit) break;
        const loc = group.funcStart >= 0 ? ` — char ${group.funcStart}` : '';
        if (!isCompact) console.log(`  ${group.signature}${loc}`);

        for (const m of group.matches) {
          if (limit && shown >= limit) break;

          if (isCompact) {
            const snippet = m.context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
            const truncated = snippet.length > 60 ? snippet.substring(0, 57) + '...' : snippet;
            const funcName = group.signature.length > 20 ? group.signature.substring(0, 20) + '...' : group.signature;
            console.log(`  char ${m.offset.toString().padEnd(10)} ${truncated.padEnd(62)} (${funcName})`);
          } else {
            const ctx = m.context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
            console.log(`    [${m.offset}] ...${ctx}...`);
            if (showCaptures && m.captures && m.captures.length > 0) {
              console.log('    Captures:');
              for (let i = 0; i < m.captures.length; i++) {
                console.log(`      $${i + 1}: ${m.captures[i]}`);
              }
              if (m.namedCaptures) {
                for (const [name, val] of Object.entries(m.namedCaptures)) {
                  console.log(`      ${name}: ${val}`);
                }
              }
            }
          }
          shown++;
        }
        if (!isCompact) console.log();
      }

      if (limit && shown < result.totalMatches) {
        console.log(`  ... and ${result.totalMatches - shown} more (use --limit to adjust)`);
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
      const isDiff = args.includes('--diff');

      if (isDiff) {
        // Two-file string comparison mode — extract positional args (skip flags and their values)
        const fileArgs = getPositionalArgs(args, ['--min-length', '--limit']);
        const filePath1 = resolve(fileArgs[0]);
        const filePath2 = fileArgs[1] ? resolve(fileArgs[1]) : undefined;
        if (!filePath2) {
          console.error('Error: --diff requires two file paths');
          process.exit(1);
        }
        const minLengthArg = getArg('--min-length');
        const minLength = minLengthArg ? parseInt(minLengthArg, 10) : 20;
        const showAll = args.includes('--all');
        const raw = args.includes('--raw');
        const limitArg = getArg('--limit');
        const limit = showAll ? 0 : (limitArg ? parseInt(limitArg, 10) : 100);

        const src1 = readFileSync(filePath1, 'utf-8');
        const src2 = readFileSync(filePath2, 'utf-8');
        console.log(`Collecting strings from ${basename(filePath1)} (${(src1.length / 1e6).toFixed(1)} MB)...`);
        const strings1 = collectStrings(src1, {});
        console.log(`Collecting strings from ${basename(filePath2)} (${(src2.length / 1e6).toFixed(1)} MB)...`);
        const strings2 = collectStrings(src2, {});

        const { diffStringSets } = await import('./lib/diff-fns.mjs');
        const diff = diffStringSets(
          strings1.map(s => s.content),
          strings2.map(s => s.content),
          { minLength, filterCode: !raw, limit },
        );
        printStringDiff(diff, basename(filePath1), basename(filePath2));
        break;
      }

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
      const isRegex = args.includes('--regex');
      const src = readSrc(filePath);

      console.log(`Checking pattern: ${isRegex ? '/' + pattern + '/' : JSON.stringify(pattern)}\n`);
      const result = checkPatch(src, pattern, replacement, { regex: isRegex });

      const statusIcon = result.status === 'UNIQUE' ? 'UNIQUE (1 match)' :
        result.status === 'NOT_FOUND' ? 'NOT FOUND (0 matches)' :
        `AMBIGUOUS (${result.matchCount} matches)`;
      console.log(`Status: ${statusIcon}\n`);

      for (const m of result.matches) {
        const ctx = m.context.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        console.log(`  Match at char ${m.offset}:`);
        console.log(`    ...${ctx}...`);
        if (isRegex && m.captures && m.captures.length > 0) {
          console.log('    Captures:');
          for (let i = 0; i < m.captures.length; i++) {
            console.log(`      $${i + 1}: ${m.captures[i]}`);
          }
        }
        console.log();
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

    case 'match': {
      const filePath = resolve(args[0]);
      const pattern = args[1];
      if (!pattern) {
        console.error('Error: regex pattern is required');
        process.exit(1);
      }

      const replacement = getArg('--replace');
      const src = readSrc(filePath);

      const result = matchPattern(src, pattern, replacement);

      console.log(`Pattern: /${result.expandedPattern}/\n`);

      const statusIcon = result.status === 'UNIQUE' ? 'UNIQUE (1 match)' :
        result.status === 'NOT_FOUND' ? 'NOT FOUND (0 matches)' :
        `AMBIGUOUS (${result.matchCount} matches)`;
      console.log(`Status: ${statusIcon}\n`);

      for (const m of result.matches) {
        console.log(`Match at char ${m.offset} (${m.matchText.length} chars):`);
        console.log(`  ${m.matchText.replace(/\n/g, '\\n')}`);
        if (m.captures.length > 0) {
          console.log('  Captures:');
          for (let i = 0; i < m.captures.length; i++) {
            console.log(`    $${i + 1}: ${m.captures[i]}`);
          }
          if (m.namedCaptures) {
            for (const [name, val] of Object.entries(m.namedCaptures)) {
              console.log(`    ${name}: ${val}`);
            }
          }
        }
        console.log();
      }

      if (result.preview) {
        console.log('Replacement preview:');
        console.log(`  - ${result.preview.before.replace(/\n/g, '\\n')}`);
        console.log(`  + ${result.preview.after.replace(/\n/g, '\\n')}\n`);
      }

      if (result.status === 'NOT_FOUND') process.exit(1);
      if (result.status === 'AMBIGUOUS') process.exit(2);
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
      const showBody = args.includes('--body');
      const showSummary = args.includes('--summary');
      const stringsOnly = args.includes('--strings-only');
      const showAll = args.includes('--all');
      const limitArg = getArg('--limit');
      const DEFAULT_DISPLAY_LIMIT = 50;
      const limit = showAll ? Infinity : (limitArg ? parseInt(limitArg, 10) : DEFAULT_DISPLAY_LIMIT);
      const nameArg = getArg('--name');
      const filterArg = getArg('--filter');
      const log = isJson ? console.error : console.log;

      // --strings-only: skip AST, just diff string sets
      if (stringsOnly) {
        const raw = args.includes('--raw');
        const src1 = readFileSync(filePath1, 'utf-8');
        const src2 = readFileSync(filePath2, 'utf-8');
        log(`Collecting strings from ${basename(filePath1)}...`);
        const strings1 = collectStrings(src1, {});
        log(`Collecting strings from ${basename(filePath2)}...`);
        const strings2 = collectStrings(src2, {});
        const { diffStringSets } = await import('./lib/diff-fns.mjs');
        const diff = diffStringSets(
          strings1.map(s => s.content),
          strings2.map(s => s.content),
          { minLength: 20, filterCode: !raw, limit: showAll ? 0 : 100 },
        );
        if (isJson) {
          console.log(JSON.stringify(diff, null, 2));
        } else {
          printStringDiff(diff, basename(filePath1), basename(filePath2));
        }
        break;
      }

      log(`Parsing ${basename(filePath1)}...`);
      const { ast: ast1, src: src1 } = await parseFile(filePath1);
      log(`Parsing ${basename(filePath2)}...`);
      const { ast: ast2, src: src2 } = await parseFile(filePath2);

      const map1 = buildFunctionMap(ast1, src1, { strings: true });
      const map2 = buildFunctionMap(ast2, src2, { strings: true });

      const result = diffFunctions(map1, map2);

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      console.log(`\nComparing ${basename(filePath1)} (${(src1.length / 1e6).toFixed(1)} MB, ${map1.length} fns) vs ${basename(filePath2)} (${(src2.length / 1e6).toFixed(1)} MB, ${map2.length} fns):\n`);
      console.log(`  Unchanged: ${result.unchanged.length} functions`);
      console.log(`  Modified:  ${result.modified.length} functions`);
      console.log(`  Added:     ${result.added.length} functions (new in v2)`);
      console.log(`  Removed:   ${result.removed.length} functions (gone from v2)`);

      // Apply --filter
      const filterFn = filterArg
        ? (fn) => {
            const pat = filterArg.toLowerCase();
            if (fn.name?.toLowerCase().includes(pat)) return true;
            if (fn.addedStrings?.some(s => s.toLowerCase().includes(pat))) return true;
            if (fn.removedStrings?.some(s => s.toLowerCase().includes(pat))) return true;
            if (fn.strings?.some(s => s.toLowerCase().includes(pat))) return true;
            return false;
          }
        : () => true;

      // --summary mode
      if (showSummary) {
        const { categorizeDiff } = await import('./lib/diff-fns.mjs');
        const summary = categorizeDiff(result);
        console.log('\nSummary:');
        for (const cat of summary) {
          console.log(`  ${cat.label}: ${cat.description}`);
        }
        break;
      }

      // Sort modified by abs(sizeDiff) descending
      const sortedModified = [...result.modified]
        .sort((a, b) => Math.abs(b.sizeDiff) - Math.abs(a.sizeDiff))
        .filter(filterFn);

      if (sortedModified.length > 0) {
        const displayCount = Math.min(limit, sortedModified.length);
        const showing = displayCount < sortedModified.length ? `, showing ${displayCount}` : '';
        console.log(`\nModified functions (${sortedModified.length}${showing}, sorted by size delta):`);
        for (const m of sortedModified.slice(0, displayCount)) {
          const delta = m.sizeDiff > 0 ? `+${m.sizeDiff}` : `${m.sizeDiff}`;
          console.log(`  ${m.name.padEnd(20)} v1: ${m.v1Size} → v2: ${m.v2Size} (${delta})  shift: ${m.shift > 0 ? '+' : ''}${m.shift}`);
          if (m.addedStrings.length > 0) console.log(`    + strings: ${m.addedStrings.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}${m.addedStrings.length > 5 ? ` (+${m.addedStrings.length - 5} more)` : ''}`);
          if (m.removedStrings.length > 0) console.log(`    - strings: ${m.removedStrings.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}${m.removedStrings.length > 5 ? ` (+${m.removedStrings.length - 5} more)` : ''}`);

          if (showBody) {
            if (!nameArg || m.name === nameArg) {
              const { diffFunctionBody } = await import('./lib/diff-fns.mjs');
              const bodyDiff = diffFunctionBody(src1, m, src2);
              if (bodyDiff) {
                console.log(`    ${'─'.repeat(70)}`);
                for (const line of bodyDiff.split('\n')) {
                  console.log(`    ${line}`);
                }
                console.log(`    ${'─'.repeat(70)}`);
              }
            }
          }
        }
        if (displayCount < sortedModified.length) {
          console.log(`  ... and ${sortedModified.length - displayCount} more (use --all to show all)`);
        }
      }

      // Show added functions
      const sortedAdded = [...result.added]
        .sort((a, b) => b.size - a.size)
        .filter(filterFn);
      if (sortedAdded.length > 0) {
        const displayCount = Math.min(limit, sortedAdded.length);
        const showing = displayCount < sortedAdded.length ? `, showing ${displayCount}` : '';
        console.log(`\nAdded functions (${sortedAdded.length}${showing}, sorted by size):`);
        for (const fn of sortedAdded.slice(0, displayCount)) {
          console.log(`  ${fn.name.padEnd(20)} v2: char ${fn.start}–${fn.end} (${fn.size})`);
          if (fn.strings?.length > 0) console.log(`    strings: ${fn.strings.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}${fn.strings.length > 5 ? ` (+${fn.strings.length - 5} more)` : ''}`);
        }
        if (displayCount < sortedAdded.length) {
          console.log(`  ... and ${sortedAdded.length - displayCount} more (use --all to show all)`);
        }
      }

      // Show removed functions
      const sortedRemoved = [...result.removed]
        .sort((a, b) => b.size - a.size)
        .filter(filterFn);
      if (sortedRemoved.length > 0) {
        const displayCount = Math.min(limit, sortedRemoved.length);
        const showing = displayCount < sortedRemoved.length ? `, showing ${displayCount}` : '';
        console.log(`\nRemoved functions (${sortedRemoved.length}${showing}, sorted by size):`);
        for (const fn of sortedRemoved.slice(0, displayCount)) {
          console.log(`  ${fn.name.padEnd(20)} v1: char ${fn.start}–${fn.end} (${fn.size})`);
          if (fn.strings?.length > 0) console.log(`    strings: ${fn.strings.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}${fn.strings.length > 5 ? ` (+${fn.strings.length - 5} more)` : ''}`);
        }
        if (displayCount < sortedRemoved.length) {
          console.log(`  ... and ${sortedRemoved.length - displayCount} more (use --all to show all)`);
        }
      }

      // Show offset shifts for unchanged functions
      if (result.unchanged.length > 0) {
        const shifts = result.unchanged.filter(u => u.shift !== 0);
        if (shifts.length > 0) {
          const avgShift = Math.round(shifts.reduce((s, u) => s + u.shift, 0) / shifts.length);
          console.log(`\nAverage offset shift for unchanged functions: ${avgShift > 0 ? '+' : ''}${avgShift}`);
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

    case 'context': {
      const filePath = resolve(args[0]);
      const charOffset = parseCharOffset(args[1]);
      const src = readSrc(filePath);

      console.log(`\nContext at char ${charOffset}:\n`);

      // Enclosing function info
      const funcStart = findFunctionStart(src, charOffset);
      if (funcStart >= 0) {
        const fn = extractFunction(src, charOffset);
        if (!fn.error) {
          console.log(`  Enclosing function: ${fn.signature}`);
          console.log(`    Range: ${fn.start}–${fn.end} (${fn.length} chars)`);
          if (fn.paramList.length > 0) {
            console.log(`    Params: ${fn.paramList.map(p => `${p.raw} (${p.index}${ordinal(p.index)})`).join(', ')}`);
          }
        }

        // Parent function
        if (funcStart > 0) {
          const parentStart = findFunctionStart(src, funcStart - 1);
          if (parentStart >= 0) {
            const parentSig = extractSignature(src, parentStart);
            console.log(`\n  Parent function: ${parentSig}`);
            console.log(`    Start: char ${parentStart}`);
          }
        }
      } else {
        console.log('  No enclosing function found (top-level code).');
      }

      // Nearby strings
      const nearStrings = collectStrings(src, { near: charOffset, filter: undefined });
      if (nearStrings.length > 0) {
        const limited = nearStrings.slice(0, 15);
        console.log(`\n  Nearby strings (${nearStrings.length} found):`);
        for (const s of limited) {
          const content = s.content.length > 60 ? s.content.substring(0, 57) + '...' : s.content;
          console.log(`    char ${s.offset.toString().padEnd(10)} ${JSON.stringify(content)}`);
        }
        if (nearStrings.length > 15) console.log(`    ... and ${nearStrings.length - 15} more`);
      }

      // Code at offset with beautify and marker
      const sliceRadius = 200;
      const sliceStart = Math.max(0, charOffset - sliceRadius);
      const sliceEnd = Math.min(src.length, charOffset + sliceRadius);
      const rawSlice = src.slice(sliceStart, sliceEnd);
      const { text: beautified } = beautify(rawSlice);

      // Try to insert a >>> marker at the approximate offset in the beautified output
      const relativeOffset = charOffset - sliceStart;
      // Find the character at the original offset to locate it in beautified text
      const targetChar = rawSlice.substring(relativeOffset, relativeOffset + 20);

      console.log(`\n  Code at offset (±${sliceRadius} chars, beautified):\n`);
      console.log('  ' + '─'.repeat(76));
      const lines = beautified.split('\n');
      let markerPlaced = false;
      for (const line of lines) {
        if (!markerPlaced && targetChar && line.includes(targetChar.substring(0, 8))) {
          console.log(`  >>> ${line}`);
          markerPlaced = true;
        } else {
          console.log(`      ${line}`);
        }
      }
      console.log('  ' + '─'.repeat(76));
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
