---
name: bundle-analyzer
description: Explore and analyze minified/bundled JavaScript code. Use when navigating large or hard-to-read JS bundles, tracing function call graphs, finding code by string literals or structural patterns, decompiling minified functions into readable output, inspecting variable scopes and references, comparing bundle versions to track changes, tracing I/O channels and detecting protocol mismatches, or building and validating patches against minified code. Ideal for any JS codebase exploration where standard tools struggle with minification or bundle size.
---

# Analyze JS Bundles

You are analyzing a minified JavaScript bundle. Use the analyzer toolkit and follow these principles to navigate the code effectively.

## Analyzer Toolkit

The `bundle-analyzer` command is available in your PATH after installation.

### Discovery Commands (fast, no AST — state-machine-based)

```bash
# Beautify: create readable copy + offset map (handles 11MB in ~0.4s)
bundle-analyzer beautify <file>

# Find: search for pattern, results grouped by enclosing function
bundle-analyzer find <file> <pattern> [--regex]

# Strings: index all string literals (the #1 landmark in minified code)
bundle-analyzer strings <file> --near <char-offset>    # strings within ±5000 chars
bundle-analyzer strings <file> --filter <substring>     # filter by content

# Extract function: pull out complete function at offset with signature + params
bundle-analyzer extract-fn <file> <char-offset>

# Trace I/O: map writers and readers for a channel, detect protocol mismatches
bundle-analyzer trace-io <file> "process.stdout.write"

# Patch check: validate a pattern matches exactly once before patching
bundle-analyzer patch-check <file> <pattern> [--replacement <string>]
```

### Deep Analysis Commands (SWC-based, ~2.5s parse for 11MB)

```bash
# Scope: list all variables accessible at an offset, grouped by scope depth
bundle-analyzer scope <file> <char-offset> [--all]

# Refs: external variables actually referenced by function (useful subset of scope)
bundle-analyzer refs <file> <char-offset>

# Calls: outgoing + incoming call graph for a function
bundle-analyzer calls <file> <char-offset>

# Map: build complete function index (11,000+ functions in a typical SDK bundle)
bundle-analyzer map <file> [--json] [--strings]

# Diff: compare two bundle versions — find moved, modified, added, removed functions
bundle-analyzer diff-fns <old-file> <new-file> [--json]

# Decompile: best-effort readable decompilation with variable annotations
bundle-analyzer decompile <file> <char-offset>
```

### Typical Workflow

1. **`find`** — locate code by string landmark (e.g., `bundle-analyzer find cli.js "agent_progress"`)
2. **`extract-fn`** — pull out the enclosing function, see signature + params
3. **`strings --near`** — see what other string landmarks are nearby
4. **`refs`** — what external variables does this function use?
5. **`calls`** — what does it call, and who calls it?
6. **`decompile`** — get a readable version with variable annotations
7. **`patch-check`** — validate your patch pattern before applying

## Core Principles

### 1. Search by content patterns, never by names

Minified variable/function names change between versions. Find code by its structural patterns:

- String literals: `"agent_progress"`, `"Execution completed"`
- API shapes: `.filter(`, `.writeUInt32LE`, `Buffer.alloc(4)`
- Unique operator patterns: nested for-loops, specific chain of method calls
- Comment markers or injected strings that survive minification

### 2. Check both sides of a boundary

When writing to an output channel (stdout, IPC, file), ALWAYS verify:
- **Producer side:** How does the code write? (format, framing, encoding)
- **Consumer side:** How does the reader parse? (line-delimited? binary-framed? protocol buffers?)

Use `trace-io` to automate this — it classifies transport protocols and warns about mismatches.

### 3. Use runtime tracing for variable inspection

When you need to know what a variable contains at runtime, inject a temporary `console.error()` (not `console.log` which may interfere with stdout protocols):

```js
console.error('[DEBUG]', JSON.stringify(D.message.content.map(b => b.type)))
```

This is faster than statically tracing through 10+ layers of minified call chains. Remove after debugging.

### 4. Minified variable naming conventions

- Variables often contain `$` — use `[\w$]+` not `\w+` in regex patterns
- Single-letter variables are common: `A`, `q`, `K`, `Y`, `z`
- Function parameters map positionally (1st, 2nd, 3rd...) — trace by position, not name
- The same letter may be reused in different scopes — always verify scope

### 5. Patch construction

When building patches against minified code:
- Use unique markers (e.g., `/*PATCHED:name*/`) for idempotency detection
- Match by content pattern, not by character offset (offsets shift between versions)
- Run `patch-check` to verify uniqueness before applying
- When the SDK updates, run `diff-fns` to find where patched functions moved

## Common Pitfalls

| Pitfall | Why it happens | Prevention |
|---|---|---|
| Wrong transport protocol | Binary framing vs line-delimited JSON on same stdout | Use `trace-io` to check both sides |
| `content[0]` not what you expect | Un-normalized messages have mixed block types | Search by `type` field, don't assume index |
| Regex matches multiple locations | Pattern not unique enough | Run `patch-check` to verify uniqueness |
| Variable refers to wrong scope | Same letter reused in nested scopes | Use `scope` or `refs` to verify |
| Patch breaks on new version | Matched by function name | Use `diff-fns` to find where code moved |
| Can't read minified function | Single-letter variables everywhere | Use `decompile` for annotated output |
