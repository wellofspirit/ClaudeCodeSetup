# bundle-analyzer — Improvement Requirements

This document captures gaps, pain points, and improvement ideas observed during real-world patch construction against the Claude Code SDK's minified `cli.js` (~11MB). The goal is to make bundle-analyzer a complete toolkit for the discovery → extraction → patch construction workflow, eliminating the need to drop to raw `node -e` scripts.

---

## Context: The Patch-Writing Workflow

When writing patches against minified JS, the workflow is:

1. **Discover** — Find where the target code lives by searching for string literals and structural patterns
2. **Understand** — Read the surrounding code, understand the function structure, identify variable names
3. **Extract** — Pull out the exact variable names that will change between versions (capture groups)
4. **Construct** — Build a regex that matches the target uniquely, with capture groups for variable names
5. **Verify** — Confirm the regex matches exactly once and the replacement produces correct output
6. **Generate** — Write the `apply.mjs` script with idempotency, matching, replacement, and verification

bundle-analyzer currently excels at step 1 (discovery via `find`, `strings`). It's adequate at step 2 (`extract-fn`, `decompile`). It's weak at steps 3-6, which is where I kept dropping to raw Node.js.

---

## Improvement 1: `slice` Command — Raw Code at Offset

### Problem

The most basic operation — "show me 300 chars of code at offset X" — has no dedicated command. I used `node -e` for this dozens of times:

```js
node -e "const fs=require('fs'); const s=fs.readFileSync('cli.js','utf8'); console.log(s.slice(7944591,7944891))"
```

`strings --near` is the closest alternative, but it filters to only string literals, discarding the code structure I actually need to see. `extract-fn` tries to find the enclosing function boundary, which sometimes picks the wrong nesting level and always involves extra parsing overhead.

### What I Need

```bash
bundle-analyzer slice cli.js 7944591           # default 500 chars
bundle-analyzer slice cli.js 7944591 300       # custom length
bundle-analyzer slice cli.js 7944591 --before 100 --after 300  # asymmetric
bundle-analyzer slice cli.js 7944591 --beautify  # run through beautifier
```

### Expected Output

```
Slice at char 7944591 (500 chars):

────────────────────────────────────────────────────────────────────────────────
if(f1.push(w1),w1.type!=="assistant"&&w1.type!=="user")continue;if(w1.type==="
assistant"){let O1=G26(w1);if(O1>0)J.setResponseLength((X1)=>X1+O1)}let o=bO([
w1]);P1.push(...o);for(let O1 of o)for(let X1 of O1.message.content){if(X1.typ
...
────────────────────────────────────────────────────────────────────────────────
```

With `--beautify`:

```
Slice at char 7944591 (500 chars, beautified):

────────────────────────────────────────────────────────────────────────────────
if (f1.push(w1), w1.type !== "assistant" && w1.type !== "user") continue;
if (w1.type === "assistant") {
  let O1 = G26(w1);
  if (O1 > 0) J.setResponseLength((X1) => X1 + O1)
}
let o = bO([w1]);
P1.push(...o);
for (let O1 of o)
  for (let X1 of O1.message.content) {
    if (X1.type !== "tool_use" && X1.type !== "tool_result") continue;
    ...
────────────────────────────────────────────────────────────────────────────────
```

### Implementation Notes

- Trivially simple: `src.slice(offset, offset + length)`
- Beautify option reuses existing `beautify()` function on the slice
- No AST parsing needed, should be near-instant
- This is the highest-value, lowest-effort improvement

---

## Improvement 2: `find` with Capture Group Extraction

### Problem

When using `find --regex`, the tool shows matches with context but doesn't extract regex capture groups. For patch scripts, capture groups are *the entire point* — I need to dynamically extract minified variable names.

Currently I have to:
1. Use `find` to discover the code location
2. Copy the pattern
3. Write a `node -e` script to run the same regex with `src.match()` and print groups
4. Copy the group values back

This round-trip happens for every single pattern in every patch script.

### Example: What I Needed

I was looking for the dequeue function. The README says to search for `async function NAME(A,q){...queuedCommands.length===0...}`. I need to capture `NAME`, `A`, and `q` since they'll be different in a new SDK version.

What I did:
```bash
bundle-analyzer find cli.js "queuedCommands.length===0" --regex
# Shows context, but I can't extract variable names from the output
```

Then had to write:
```bash
node -e "
const src = require('fs').readFileSync('cli.js','utf8');
const m = src.match(/async function ([\w\$]+)\(([\w\$]+),([\w\$]+)\)\{if\(\(await \2\(\)\)\.queuedCommands\.length===0\)return;/);
console.log('fn:', m[1], 'param1:', m[2], 'param2:', m[3]);
"
```

### What I Need

```bash
bundle-analyzer find cli.js \
  'async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(\(await \2\(\)\)\.queuedCommands\.length===0\)return;' \
  --regex --captures
```

### Expected Output

```
Found 1 match in 1 function:

  async function zO6(A,q) — char 5216764
    [5216764] Match (95 chars):
      async function zO6(A,q){if((await A()).queuedCommands.length===0)return;
    Captures:
      $1: zO6
      $2: A
      $3: q
```

### Implementation Notes

- In `find.mjs`, the regex match object `m` already has capture groups via `m[1]`, `m[2]`, etc.
- The `matches.push()` call currently stores `{ offset, matchText }` — add `captures: [...m].slice(1)` (or named groups via `m.groups`)
- In the CLI output, display capture groups when `--captures` flag is present and the regex has groups
- Named capture groups would be even better: `(?<fnName>[\w$]+)` → `fnName: zO6`

---

## Improvement 3: `\V` Shorthand for Minified Variable Pattern

### Problem

Every regex pattern in patch work uses `[\w$]+` to match minified identifiers (which can contain `$`). It's verbose, easy to get wrong (`\w+` misses `$`), and clutters patterns.

### Current Pain

```bash
bundle-analyzer find cli.js \
  'async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(\(await \2\(\)\)\.queuedCommands' \
  --regex
```

### Proposed Shorthand

```bash
bundle-analyzer find cli.js \
  'async function (%V%)\((%V%),(%V%)\)\{if\(\(await \2\(\)\)\.queuedCommands' \
  --regex
```

`%V%` expands to `[\w$]+` before the regex is compiled. This is a simple string replace in the CLI before passing to `new RegExp()`.

### Why Not `\V`

`\V` might conflict with regex escape sequences or shell escaping. `%V%` is unambiguous — it's never valid regex syntax and doesn't need shell quoting. But either would work.

### Implementation Notes

- Single line in `find.mjs` and `patch-check.mjs`: `pattern = pattern.replace(/%V%/g, '[\\w$]+')`
- Document it in SKILL.md under "Minified variable naming conventions"
- Consider also `%S%` for string literal matching: `"[^"]*"` or `"(?:[^"\\]|\\.)*"`

---

## Improvement 4: `extract-fn` with Depth Control

### Problem

`extract-fn` finds the **tightest** enclosing function around an offset. In minified code with deep nesting (arrow functions inside for-loops inside async IIFEs inside class methods), the tightest function is often a tiny arrow callback, not the actual function I care about.

### Example That Failed

At offset 7944719, I wanted the Task tool's `async call()` method (~3000 chars). Instead, `extract-fn` returned a 282-char arrow function fragment:

```
Function: (X1)=>X1+O1)}let o=bO([w1]);P1.push(...o);for(let O1 of o)...
```

This is a lambda inside the for-await loop inside the Task tool's call method. I needed the call method, not the lambda.

### What I Need

```bash
# Show the nesting chain at an offset
bundle-analyzer extract-fn cli.js 7944719 --stack
```

Output:
```
Function nesting at char 7944719:

  Depth 0: (X1)=>X1+O1  (7944719–7944730, 11 chars)
  Depth 1: async()=>{...}  (7942375–7945200, 2825 chars)
  Depth 2: async call({prompt:A,...},J,X,D,j)  (7938000–7946000, 8000 chars)
  Depth 3: [top-level IIFE]  (7860000–7950000, 90000 chars)

Use --depth N to extract a specific level.
```

Then:
```bash
bundle-analyzer extract-fn cli.js 7944719 --depth 2
```

Extracts the `async call()` method at depth 2.

### Implementation Notes

The current `findFunctionStart` already uses a `funcStack` that tracks nesting — but only returns the tightest match (`bestFunc` picks smallest range). To support depth:

1. Keep all matching functions in the stack, not just the best
2. Sort by size (smallest = depth 0)
3. `--stack` prints the chain
4. `--depth N` selects the Nth level

Alternatively, a simpler approach: `--depth N` runs `findFunctionStart` N times, each time using the previous result's start offset minus 1 as the new search offset. This avoids changing the core algorithm but is O(N × scan), which is fine since N is small (1-3).

---

## Improvement 5: `context` Command — One-Shot Understanding

### Problem

Understanding code at an offset currently requires 3-4 separate commands:

```bash
bundle-analyzer extract-fn cli.js 7944719      # what function am I in?
bundle-analyzer strings cli.js --near 7944719   # what strings are nearby?
bundle-analyzer refs cli.js 7944719             # what variables are used? (slow - 2.5s AST parse)
bundle-analyzer scope cli.js 7944719            # what's in scope? (slow - 2.5s AST parse)
```

Each command re-reads the 11MB file. Three of them re-parse the AST. For a quick "what's going on here?" this is too much friction.

### What I Need

```bash
bundle-analyzer context cli.js 7944719
```

### Expected Output

```
Context at char 7944719:

  Enclosing function: async call({prompt:A,...},J,X,D,j)
    Range: 7938000–7946000 (8000 chars)
    Params: A=prompt (1st), J (2nd), X (3rd), D (4th), j (5th)

  Parent function: async()=>{...}
    Range: 7937000–7947000

  Nearby strings (±2000 chars):
    char 7943700    "text"
    char 7944067    "completed"
    char 7944824    "tool_use"
    char 7944846    "tool_result"
    char 7944955    "agent_progress"

  Code at offset (±200 chars, beautified):
    ...
    for (let O1 of o)
      for (let X1 of O1.message.content) {
        if (X1.type !== "tool_use" && X1.type !== "tool_result") continue;
        if (j) j({
    >>>     toolUseID: `agent_${D.message.id}`,     ◄── offset 7944719
            data: { message: O1, normalizedMessages: P1, ...
    ...
```

### Implementation Notes

- Uses existing `findFunctionStart`, `extractSignature`, `collectStrings` with `near` option
- Code snippet is just `slice` + `beautify`
- No AST parsing needed (skips `refs` and `scope` for speed)
- Could add `--deep` flag that also includes refs/scope (with AST parse)
- The `>>>` marker shows exactly where the offset falls in the beautified code

---

## Improvement 6: `match` Command — Regex with Patch Semantics

### Problem

`patch-check` validates that a literal string matches exactly once. But patches need **regex** matching with **capture groups** and **replacement preview**. Currently `patch-check` only does literal string matching.

The `find` command supports regex but lacks uniqueness validation and replacement preview. Neither command extracts capture groups.

I need a single command that does what my `apply.mjs` scripts do: regex match with capture groups, uniqueness check, and replacement preview.

### What I Need

```bash
bundle-analyzer match cli.js \
  'async function (%V%)\((%V%),(%V%)\)\{if\(\(await \2\(\)\)\.queuedCommands\.length===0\)return;' \
  --replace 'async function $1($2,$3){/*PATCHED*/while(HST_CHECK()){let _h=HST_DEQUEUE();if(_h)$3((z)=>({...z,queuedCommands:[...z.queuedCommands,_h]}))}if((await $2()).queuedCommands.length===0)return;'
```

### Expected Output

```
Pattern: /async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(\(await \2\(\)\)\.queuedCommands\.length===0\)return;/

Status: UNIQUE (1 match) ✓

Match at char 5216764 (95 chars):
  async function zO6(A,q){if((await A()).queuedCommands.length===0)return;

Captures:
  $1: zO6
  $2: A
  $3: q

Replacement preview:
  - async function zO6(A,q){if((await A()).queuedCommands.length===0)return;
  + async function zO6(A,q){/*PATCHED*/while(HST_CHECK()){let _h=HST_DEQUEUE();if(_h)q((z)=>({...z,queuedCommands:[...z.queuedCommands,_h]}))}if((await A()).queuedCommands.length===0)return;

Replacement uses captures: $1→zO6, $2→A, $3→q
```

### How It Differs From Existing Commands

| Feature | `find` | `patch-check` | `match` (new) |
|---|---|---|---|
| Regex support | Yes | No (literal only) | Yes |
| Capture groups | No | No | Yes |
| Uniqueness check | No (just counts) | Yes (exits 1 if not unique) | Yes |
| Replacement preview | No | Yes (literal only) | Yes (with $N substitution) |
| `%V%` shorthand | No | No | Yes |
| Exit code on failure | No | Yes | Yes |

### Implementation Notes

- This is essentially a merge of `find --regex --captures` and `patch-check --replacement`
- The `--replace` string supports `$1`, `$2`, etc. which get substituted with captured groups
- `%V%` expansion happens before regex compilation
- Could also accept `--replace-file` for complex replacements that don't fit on command line
- Exit code 0 if unique, 1 if not found, 2 if ambiguous

---

## Improvement 7: `extract-fn` for Brace-less Bodies

### Problem

Minified code frequently has brace-less loop/if bodies:

```js
for await(let X of Y)Z.push(X),foo(X),bar(X);
```

This is a `for-await` loop with a body that's a single comma-expression statement (no braces). The current `extract-fn` tracks `{` / `}` pairs to find function boundaries. When the offset is inside this brace-less for-await body, it may not recognize the for-await as a boundary and instead return a parent function.

More importantly, when I ask "extract the body of this for-await loop," there's no function boundary to extract because there are no braces.

### What I Need

The tool should recognize statement-level boundaries, not just function boundaries. When the offset is inside a brace-less for/if/while body:

```bash
bundle-analyzer extract-fn cli.js 7941400
```

Should report:
```
Note: Offset is inside a brace-less for-await body (no function boundary)
Statement: for await(let H1 of LR({...}))$1.push(H1),eD1(D1,H1,a,J.options.tools),zDA(Y1.agentId,Hu1(D1),J.setAppState);
```

### Implementation Notes

This is harder than the other improvements. The state machine would need to track:
- `for`/`for await`/`while`/`if` keywords
- Whether the following body uses `{` (block) or is a single statement
- The extent of a comma-expression statement (ends at `;`)

A simpler approach: add a `--statement` flag that extracts the containing statement (delimited by `;`) rather than the containing function. This is easy to implement — scan backwards and forwards from offset to find the nearest `;` boundaries.

---

## Improvement 8: `patch-build` — Generate Patch Script Boilerplate

### Problem

Every `apply.mjs` follows the exact same structure:

1. Read `cli.js`
2. Check for `/*PATCHED:name*/` marker (idempotency)
3. Match a regex to find the target code
4. Extract variable names from capture groups
5. Build the replacement string
6. Verify uniqueness (exactly 1 match)
7. Apply the replacement
8. Write back
9. Re-read and verify marker exists

Writing this boilerplate is tedious and error-prone. The regex escaping alone takes several iterations to get right.

### What I Need

```bash
bundle-analyzer patch-build cli.js \
  --name "task-notification" \
  --match 'async function (%V%)\((%V%),(%V%)\)\{if\(\(await \2\(\)\)\.queuedCommands\.length===0\)return;' \
  --captures 'dequeueFn,paramA,paramQ' \
  --replace-template 'async function ${dequeueFn}(${paramA},${paramQ}){/*PATCHED:task-notification*/while(${hstCheck}()){let _h=${hstDequeue}();if(_h)${paramQ}((z)=>({...z,queuedCommands:[...z.queuedCommands,_h]}))}if((await ${paramA}()).queuedCommands.length===0)return;' \
  --output patch/task-notification/apply.mjs
```

### Expected Output

Generates a complete `apply.mjs` script:

```js
/**
 * Patch: task-notification
 * Auto-generated by bundle-analyzer patch-build
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '../../node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
const MARKER = '/*PATCHED:task-notification*/';

let src = readFileSync(CLI_PATH, 'utf8');

if (src.includes(MARKER)) {
  console.log('[task-notification] Already patched, skipping.');
  process.exit(0);
}

const V = '[\\w$]+';

const match = src.match(new RegExp(
  `async function (${V})\\((${V}),(${V})\\)\\{if\\(\\(await \\2\\(\\)\\)\\.queuedCommands\\.length===0\\)return;`
));

if (!match) {
  console.error('[task-notification] Pattern not found.');
  process.exit(1);
}

const [fullMatch, dequeueFn, paramA, paramQ] = match;
console.log(`[task-notification] Found: ${dequeueFn}(${paramA},${paramQ})`);

// Verify uniqueness
const occurrences = src.split(fullMatch).length - 1;
if (occurrences !== 1) {
  console.error(`[task-notification] Pattern found ${occurrences} times (expected 1).`);
  process.exit(1);
}

const replacement = `async function ${dequeueFn}(${paramA},${paramQ}){${MARKER}while(${hstCheck}()){let _h=${hstDequeue}();if(_h)${paramQ}((z)=>({...z,queuedCommands:[...z.queuedCommands,_h]}))}if((await ${paramA}()).queuedCommands.length===0)return;`;

src = src.replace(fullMatch, replacement);
writeFileSync(CLI_PATH, src);

// Verify
const verify = readFileSync(CLI_PATH, 'utf8');
if (!verify.includes(MARKER)) {
  console.error('[task-notification] Verification failed.');
  process.exit(1);
}
console.log('[task-notification] Patch applied successfully.');
```

### Implementation Notes

- This is the highest-effort improvement but also the highest payoff for repeated patch work
- The template needs to handle multiple match steps (some patches have 2-3 sequential finds)
- Could support `--multi` mode where you define multiple match/replace steps
- The generated script should be a starting point that humans edit, not a finished product
- Consider a `--dry-run` mode that runs the generated script against the current `cli.js` and shows what would change
- The `--captures` flag names the groups for use in the replacement template. Unnamed captures would be `$1`, `$2`, etc.

---

## Improvement 9: Better `find` Output Formatting

### Problem

When `find` returns many matches (e.g., 34 matches for "queuedCommands"), the output is overwhelming. Every match shows ±80 chars of context, most of which is irrelevant. Scrolling through 34 matches to find the one I care about is slow.

### What I Need

**Compact mode (default for >10 matches):**

```bash
bundle-analyzer find cli.js "queuedCommands" --compact
```

```
Found 34 matches in 20 functions:

  char 5216666   (K)=>({...K,queuedCommands:[...K.queuedCo...   (k0)
  char 5216803   if((await A()).queuedCommands.length===0)r...   (zO6)
  char 5216858   if(z.queuedCommands.length===0)return z;r...   (zO6)
  char 5217051   queuedCommands:K.queuedCommands.filter((Y...   (EU7)
  ...
```

**Filtered mode:**

```bash
bundle-analyzer find cli.js "queuedCommands" --near 5216800
```

Only shows matches within ±5000 chars of the given offset.

**Count mode:**

```bash
bundle-analyzer find cli.js "queuedCommands" --count
```

```
Found 34 matches in 20 functions:
  k0: 2 matches
  zO6: 4 matches
  EU7: 2 matches
  ...
```

### Implementation Notes

- `--compact`: truncate context to ~50 chars, one line per match
- `--near N`: filter matches to those within ±5000 chars of offset N
- `--count`: just show counts per function
- `--limit N`: show only first N matches (with "and X more" footer)
- These could also be `--head N` for consistency with grep-like tools

---

## Improvement 10: `patch-check` with Regex Support

### Problem

`patch-check` only supports literal string matching. But patch patterns are almost always regex (because variable names change between versions). To validate a regex pattern's uniqueness, I have to write a `node -e` script.

### What I Need

```bash
bundle-analyzer patch-check cli.js \
  'async function [\w$]+\([\w$]+,[\w$]+\)\{if\(\(await [\w$]+\(\)\)\.queuedCommands\.length===0\)return;' \
  --regex
```

### Expected Output

```
Pattern: /async function [\w$]+\([\w$]+,[\w$]+\)\{if\(\(await [\w$]+\(\)\)\.queuedCommands\.length===0\)return;/

Status: UNIQUE (1 match) ✓

Match at char 5216764:
  ...async function zO6(A,q){if((await A()).queuedCommands.length===0)return;...
```

### Implementation Notes

- Simple extension to existing `patch-check.mjs`
- When `--regex` flag is present, use `new RegExp(pattern)` instead of `src.indexOf(pattern)`
- Combine with `%V%` expansion for convenience
- This could be obviated by the `match` command (Improvement 6), but it's simpler and fits the existing command structure

---

## Priority Ranking

| # | Improvement | Effort | Impact | Priority |
|---|---|---|---|---|
| 1 | `slice` — raw code at offset | Trivial (10 lines) | High | P0 |
| 2 | `find --captures` — capture group extraction | Low (20 lines) | High | P0 |
| 10 | `patch-check --regex` — regex uniqueness validation | Low (15 lines) | Medium | P1 |
| 3 | `%V%` shorthand expansion | Trivial (1 line each in find/patch-check/match) | Medium | P1 |
| 9 | Better `find` output (compact/near/count) | Low (30 lines) | Medium | P1 |
| 4 | `extract-fn --depth/--stack` | Medium (50 lines) | Medium | P2 |
| 5 | `context` — one-shot understanding | Medium (80 lines, combines existing) | Medium | P2 |
| 6 | `match` — regex + captures + uniqueness + preview | Medium (100 lines) | High | P2 |
| 7 | `extract-fn` for brace-less bodies | Hard (state machine changes) | Low | P3 |
| 8 | `patch-build` — generate patch scripts | Hard (template engine) | High (for repeat use) | P3 |

**Recommended implementation order:** 1 → 2 → 10 → 3 → 9 → 6 (which subsumes 2+10+3) → 4 → 5 → 8 → 7

---

## Appendix: Real Examples That Triggered Each Improvement

### Improvement 1 (`slice`)

Every time I needed to verify what code was at an offset after `find` returned a match. Happened ~15 times in one session. Example:

```bash
# What I did (every time):
node -e "const s=require('fs').readFileSync('cli.js','utf8'); console.log(s.slice(7944591,7944891))"

# What I wanted:
bundle-analyzer slice cli.js 7944591 300
```

### Improvement 2 (`find --captures`)

Needed to extract the dequeue function name and parameter names. The README says "find by pattern, extract variable names dynamically." This is the core operation of every apply.mjs.

```bash
# What I did:
bundle-analyzer find cli.js "queuedCommands.length===0"  # find location
# Then:
node -e "const s=require('fs').readFileSync('cli.js','utf8'); const m=s.match(/async function ([\w\$]+)\(([\w\$]+),([\w\$]+)\)\{/); console.log(m[1],m[2],m[3])"

# What I wanted:
bundle-analyzer find cli.js 'async function (%V%)\((%V%),(%V%)\)\{.*queuedCommands' --regex --captures
```

### Improvement 4 (`extract-fn --depth`)

Trying to see the Task tool's `call()` method. The offset was inside a tiny lambda, and `extract-fn` returned the lambda instead of the method.

```bash
# What I got:
bundle-analyzer extract-fn cli.js 7944719
# Output: (X1)=>X1+O1 — a 11-char arrow function. Useless.

# What I wanted:
bundle-analyzer extract-fn cli.js 7944719 --depth 2
# Output: the full async call() method (8000 chars)
```

### Improvement 6 (`match`)

Building the regex for each patch, I needed to iteratively test: Does this regex match exactly once? What does it capture? What does the replacement look like? Each iteration required a new `node -e` script.

```bash
# What I did (per iteration):
node -e "
const s=require('fs').readFileSync('cli.js','utf8');
const re = /pattern/;
const m = s.match(re);
console.log('count:', (s.match(new RegExp(re.source,'g'))||[]).length);
console.log('groups:', m?.slice(1));
console.log('replaced:', m?.[0].replace(re, replacement));
"

# What I wanted:
bundle-analyzer match cli.js 'pattern' --replace 'replacement'
```
