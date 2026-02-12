# Minified JS Analyzer — Full Requirements

CLI toolkit for reverse-engineering large minified JavaScript bundles (10+ MB). Designed for the specific workflow of patching SDK internals: find code by landmarks, understand its structure, trace data flow, and validate patches.

## Usage

```
bun ~/.claude/skills/reverse-engineer-js/cli.mjs <command> <file> [options]
```

## Dependencies

- `@swc/core` — Rust-based JS parser. Handles 11MB files in ~2.5s. Required by commands that need AST analysis (scope, refs, calls, map, diff-fns).
- Node.js builtins only for everything else.

---

## Commands

### 1. `beautify <file> [--output <path>]`

**Purpose:** Create a human-readable copy of a minified file. This is always the first step — you can't read a 376,000-character single line.

**What it does:**
- Reads the minified source and splits it into lines at syntax boundaries (`;`, `{`, `}`) while respecting strings, comments, regex literals, and template literals.
- Adds indentation (2 spaces per brace depth level) so nested code is visually scoped.
- Produces an **offset map** — a JSON array where `offsetMap[lineNumber]` gives the original char offset of that line. This lets other commands cross-reference between beautified output and the original file.

**Why not Prettier/ESLint?** They OOM or take 30+ minutes on 10+ MB files. This custom state-machine approach processes 11MB in ~0.4 seconds.

**Input:** File path, optional `--output <path>` for the beautified file.

**Output (files):**
- `<file>.beautified.js` — the readable version
- `<file>.offsetmap.json` — line-to-offset mapping

**Output (stdout):**
```
Reading cli.js...
File size: 11.4 MB
Beautified: 376630 lines written to cli.js.beautified.js
Offset map: 376630 entries written to cli.js.offsetmap.json
Time: 0.44s
```

**Implementation:** State machine tracks 7 states (normal, single-quote string, double-quote string, template literal, regex, line comment, block comment). Only splits on `;{}` when in normal state.

---

### 2. `extract-fn <file> <char-offset>`

**Purpose:** Given a character offset (from grep, `find`, or manual inspection), extract the complete function containing that offset — its full signature, parameter list, and beautified body.

**What it does:**
1. Forward-scans the source tracking function/arrow/method-shorthand signatures and brace depth to build a stack of enclosing functions at the given offset.
2. Finds the **innermost** enclosing function.
3. Skips past the parameter list `(...)` (which may contain destructuring `{}` that must NOT be confused with the function body).
4. Extracts from signature start to the matching closing `}`.
5. Parses the parameter list into individual params with positional indices.
6. Beautifies the extracted code.

**Why this matters:** In minified code, parameters map positionally — knowing that `D` is the 4th parameter is critical because callers pass arguments by position. The raw code `async call({prompt:A,subagent_type:q,...},J,X,D,j)` doesn't tell you positions at a glance.

**Input:** File path, character offset (integer).

**Output (stdout):**
```
Function: async call({prompt:A,subagent_type:q,...},J,X,D,j)
Offset:   7984321 → 7993406 (9085 chars)
Params:   {prompt:A,...} (1st), J (2nd), X (3rd), D (4th), j (5th)
────────────────────────────────────────────────────────────────
<beautified function body>
```

**Implementation:** State-machine-based (no AST needed). Uses forward scan with function-signature detection for `function`, `async function`, `async method(`, `=>` patterns.

---

### 3. `scope <file> <char-offset> [--all]`

**Purpose:** List every variable accessible at a given character offset, organized by scope depth. Answers: "what names can my injected code use at this point?"

**What it does:**
1. Parses the entire file with SWC.
2. Walks the AST building a scope tree — each function, arrow, block, for-loop, and catch clause creates a new scope with a parent pointer.
3. Finds the innermost scope containing the given offset.
4. Walks the parent chain outward, collecting all variable declarations (params, `let`, `const`, `var`, function declarations, class declarations, destructured bindings).
5. Groups variables by scope depth.

**Why `--all` exists:** Module scope in an 11MB bundle typically has 18,000+ variable declarations. Without `--all`, module-scope vars are capped at 30. Use `--all` when you need to find a specific module-level function.

**Input:** File path, character offset, optional `--all` flag.

**Output (stdout):**
```
Scope at char 7988095 (function, char 7987841–7989673):

  # Immediate scope (function, char 7987841–7989673)
  A          param         char 7987841
  q          param         char 7987841
  ...

  # Closure depth 1 (module, char 0–11387761)
  ySq        var           char 357
  CSq        destructured  char 378
  ... and 18828 more (use --all to show all)

Total: 18875 variables in scope
```

**Implementation:** SWC parse + custom AST walker. Handles `FunctionDeclaration`, `FunctionExpression`, `ArrowFunctionExpression`, `ClassMethod`, `MethodProperty`, `ClassDeclaration`, `BlockStatement`, `ForStatement`, `ForInStatement`, `ForOfStatement`, `CatchClause`, `VariableDeclaration`, and pattern bindings (ObjectPattern, ArrayPattern, RestElement, AssignmentPattern).

---

### 4. `trace-io <file> <pattern>`

**Purpose:** Map an I/O channel — find everything that writes to it, everything that reads from it, classify the transport protocol, and warn about mismatches.

**What it does:**
1. Finds all occurrences of the pattern (e.g., `process.stdout.write`) in the source.
2. For each write site, examines ±256 chars of surrounding context to classify the transport:
   - `Buffer.alloc` + `writeUInt32LE` → **BINARY** (length-prefixed)
   - `JSON.stringify` + `"\n"` → **JSON+NL** (newline-delimited JSON)
   - Raw string concatenation → **TEXT**
3. Searches for corresponding reader patterns (`createInterface`, `on('data')`, `readUInt32LE`, `on('line')`).
4. Detects protocol mismatches (e.g., binary writer + readline reader).

**Why this matters:** The SDK uses stdout for two incompatible protocols simultaneously — binary length-prefixed messages (via `fY1`) and newline-delimited JSON (via the SDK transport). Using the wrong one causes silent data corruption. This command surfaces that immediately.

**Input:** File path, pattern string.

**Output (stdout):**
```
Writers (33 found):
  char 7988354    _ptu                 JSON+NL (newline-delimited JSON)
  char 10580668   fY1                  BINARY (UInt32 length-prefixed)
  ...

Readers (92 found):
  char 10472253   $wz                  readline (line-based)
  ...

⚠  Protocol mismatch: binary writer(s) found but reader uses line-based protocol
```

**Implementation:** String `indexOf` for pattern matching. Heuristic context classification. Hardcoded reader pattern table.

---

### 5. `find <file> <pattern> [--regex] [--context <N>]`

**Purpose:** Search for a string or regex pattern, but instead of raw grep output, show each match with its **enclosing function context**. This is the #1 starting operation in any reverse-engineering session — you have a string literal landmark and want to know which function uses it.

**What it does:**
1. Finds all matches of the pattern in the source (string `indexOf` or `RegExp`).
2. For each match, determines the enclosing function using `findFunctionStart()`.
3. Extracts a lightweight function signature (name + params, without beautifying the full body).
4. Shows ±80 chars (or `--context N` chars) of raw source around the match.
5. Groups matches by enclosing function — if 5 matches are in the same function, they appear together under one header.
6. Reports the function's char range so you can follow up with `extract-fn`.

**Why not just grep?** Grep gives you line numbers, but in a minified file every match is on "line 1". Even with byte offsets, you don't know which function you're in. This command bridges the gap — it's grep with semantic context.

**Input:** File path, search pattern, optional `--regex` flag, optional `--context N` (default 80).

**Output (stdout):**
```
Found 5 matches in 2 functions:

  async call({prompt:A,...},J,X,D,j) [7984321–7993406]
    char 7988354  ...JSON.stringify({type:"agent_progress",agent_id:...
    char 7988514  ...type:"agent_progress",status:"started"...
    char 7988670  ...type:"agent_progress",status:"completed"...

  function p6(A,q,K) [9100000–9102000]
    char 9100200  ...if(A.type==="agent_progress")...
    char 9100450  ...emit("agent_progress",{...
```

**Implementation:** State-machine-based (no AST). Fast — no SWC parse overhead. Reuses `findFunctionStart()` and signature extraction from extract-fn module.

---

### 6. `refs <file> <char-offset>`

**Purpose:** Find the external variables that a function actually **references** — the useful subset of `scope`. While `scope` tells you everything that's *available* (18,000+ at module level), `refs` tells you what the function actually *uses* (typically 5-20 names).

**What it does:**
1. Parses with SWC.
2. Builds the scope tree, finds the function scope at the given offset.
3. Walks **only** the function's AST subtree, collecting every `Identifier` node.
4. Filters out identifiers that are declared locally within the function (params, local `let`/`const`/`var`).
5. Filters out identifiers that appear as property names in member expressions or object keys (e.g., in `obj.foo`, `foo` is a property access, not a variable reference).
6. For each remaining external reference, looks up its declaration in parent scopes.
7. Groups by source scope, counts usages, records char offsets of each usage.

**Why this matters for patching:** When you inject code at a patch point, you need to know which closure variables are available AND actually used by the surrounding code. If the function references `D` (the message param) and `j` (the progress callback), those are the variables your injected code can safely use. Module-scope functions like `fY1` are also available but only the ones referenced nearby are relevant.

**Input:** File path, character offset.

**Output (stdout):**
```
External references from async call({prompt:A,...},J,X,D,j) [7984321–7993406]:

  From parent scope (arrow, char 7983946–7986691):
    n          param     3 refs at [7984500, 7984600, 7985200]
    e          param     5 refs at [7984400, 7984800, ...]

  From module scope:
    xNY        function  1 ref  at [7984650]
    VM         function  1 ref  at [7984700]
    l8         function  1 ref  at [7984680]
    tu4        function  1 ref  at [7985100]
    Error      global    3 refs at [7984690, 7984750, 7984790]

Total: 13 external references to 8 unique names
```

**Implementation:** SWC-based. Key challenge: distinguishing variable references from property accesses (`foo` in `obj.foo` is not a variable ref, but `foo` in `foo.bar` IS a variable ref — it's the object being accessed). Handle by checking if the Identifier's parent is a `MemberExpression` and the Identifier is the `property` (not `object`) field.

---

### 7. `calls <file> <char-offset>`

**Purpose:** Show the call graph for a function — what functions it calls (outgoing) and what functions call it (incoming). This is critical for tracing execution chains like `sdY() → O6q() → tdY() → tool.call()`.

**What it does:**

**Outgoing calls:**
1. Parses with SWC.
2. Finds the function at the given offset.
3. Walks the function's AST subtree collecting every `CallExpression`.
4. Extracts the callee name:
   - Simple identifier: `foo(...)` → `foo`
   - Member expression: `obj.method(...)` → `obj.method`
   - Chained: `a.b.c(...)` → `a.b.c`
   - Computed/complex: `arr[0](...)` → `<computed>`
5. Groups by callee name, counts occurrences, records char offsets.

**Incoming calls:**
1. Determines the function's name (if it has one — from variable assignment, object key, or function declaration).
2. Searches the entire source for call expressions matching that name.
3. For each call site, finds the enclosing function to show the caller.
4. For single-letter function names (common in minified code), flags that results will include false positives from same-named variables in different scopes.

**Why this matters:** The SDK has deeply nested call chains where one function wraps another wraps another. Tracing `tool.call()` → understanding what `sdY()` does → discovering `O6q()` wraps `parentToolUseID` was a multi-hour manual process. This command automates the first step.

**Input:** File path, character offset.

**Output (stdout):**
```
Call graph for async call({prompt:A,...},J,X,D,j) [7984321–7993406]:

Outgoing calls (12 unique):
  J.getAppState          1x  [7984450]
  xNY                    1x  [7984650]
  VM                     1x  [7984700]
  l8                     1x  [7984680]
  Error                  3x  [7984690, 7984750, 7984790]
  tu4                    1x  [7985100]
  iK1                    1x  [7985050]
  ...

Incoming calls (3 found):
  ⚠ "call" is a common name — results may include false positives
  char 8100200  in async function sdY(A,q,K,Y) [8100000–8102000]
    ...entry.call(input,session,context,D,j)...
  char 9500100  in function tdY(A) [9500000–9500500]
    ...A.call({prompt:q,...})...
```

**Implementation:** SWC for outgoing (AST walk is precise). String search + `findFunctionStart` for incoming (heuristic — matches `NAME(` pattern in source). Incoming results for short names (≤3 chars) get a false-positive warning.

---

### 8. `strings <file> [--near <char-offset>] [--filter <pattern>]`

**Purpose:** Build an index of every string literal in the file. Strings are the #1 landmark in minified code — they survive minification unchanged and are the primary way to locate code of interest.

**What it does:**
1. Scans the source using the state machine, collecting every string literal (single-quoted, double-quoted, and template literals without expressions).
2. Records: the string's content, its char offset, its length, and the enclosing function name (via `findEnclosingFuncName`).
3. Optionally filters by `--near <offset>` (only strings within ±5000 chars) or `--filter <pattern>` (content substring match).
4. Sorts by char offset.

**Why this matters:** When starting reverse-engineering, you don't know where anything is. Strings are your map. Searching for `"agent_progress"` tells you where the agent progress feature lives. Searching for `"Execution completed"` tells you where the completion handler is. This command gives you all the landmarks in one shot.

**Input:** File path, optional `--near <char-offset>`, optional `--filter <pattern>`.

**Output (stdout):**
```
Strings near char 7988000 (±5000):

  char 7985200  "Agent Teams is not yet available on your plan."  in call()
  char 7986300  "In-process teammates cannot spawn other teammates"  in call()
  char 7988100  "agent_progress"  in [anonymous]
  char 7988200  "started"  in [anonymous]
  char 7988400  "completed"  in [anonymous]
  char 7989100  "subagent_result"  in [anonymous]

Found 6 strings
```

**Implementation:** State-machine-based scan (no AST). When the state machine enters a string state, record the start offset. When it exits, capture the content. For template literals with `${}` expressions, only capture the static parts or skip entirely.

---

### 9. `patch-check <file> <pattern> [--replacement <string>]`

**Purpose:** Pre-flight validation before applying a patch. Confirms the search pattern matches exactly once, shows context, and optionally simulates the replacement. Prevents the most common patching failure: a pattern that matches 0 or >1 times.

**What it does:**
1. Searches the source for all matches of the pattern (string or regex).
2. Reports the count:
   - **0 matches:** Error — pattern not found (likely SDK version changed).
   - **1 match:** Success — shows the match with ±200 chars of context.
   - **>1 matches:** Error — pattern is not unique. Shows all match locations with context so you can add more specificity.
3. If `--replacement` is provided, shows a side-by-side diff of what would change.
4. Checks for common pitfalls:
   - Pattern contains a minified function name (warns it may break on version updates).
   - Pattern spans a string boundary (the match crosses from code into a string literal).
   - Pattern is inside a comment.

**Why this matters:** When the SDK updates, patches silently break. The most common failure is a pattern that used to match once now matches zero times (code moved) or multiple times (code was duplicated). Running `patch-check` before `apply.mjs` catches this immediately.

**Input:** File path, pattern string (searched literally), optional `--replacement` string.

**Output (stdout):**
```
Pattern: "for await(let D1 of"
Status: ✓ UNIQUE (1 match)

Match at char 7988000:
  ...W1=VB1(J.options.tools);for await(let D1 of cR({...n,override:{...

Replacement preview:
  - ...W1=VB1(J.options.tools);for await(let D1 of cR({...n,override:{...
  + ...W1=VB1(J.options.tools);/*PATCHED*/for await(let D1 of cR({...n,override:{...

Checks:
  ✓ Pattern is in code context (not inside a string or comment)
  ⚠ Pattern contains short identifier "D1" — may break if minifier renames it
```

**Implementation:** String `indexOf` with uniqueness check (`indexOf(pattern, firstMatch + 1) === -1`). State machine to verify match is in code context. Heuristic warning for short identifiers (`/\b[A-Za-z_$]{1,3}\b/` in pattern).

---

### 10. `map <file> [--json] [--strings]`

**Purpose:** Build a complete function index of the entire bundle — a "table of contents" you can search through without re-parsing. Parse once (~2.5s), then all lookups are instant via `grep`/`jq` on the output.

**What it does:**
1. Parses the file with SWC.
2. Walks the entire AST collecting every function-like node (FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, MethodProperty, ClassMethod).
3. For each function, records:
   - **name:** Inferred from declaration, assignment, object key, or `<anonymous>`
   - **start/end:** Character offsets
   - **paramCount:** Number of parameters
   - **isAsync:** Whether it's async
   - **isGenerator:** Whether it uses `function*`
   - **strings:** (if `--strings`) All string literals inside the function body
   - **signature:** First 120 chars of the function source (for quick identification)
4. Sorts by char offset.

**Why this matters:** The 11MB `cli.js` contains thousands of functions. Without a map, finding a specific function requires re-parsing every time. With a map, you can:
- `jq '.[] | select(.strings | any(contains("agent")))' cli.map.json` — find all functions mentioning "agent"
- `jq '.[] | select(.paramCount == 5 and .isAsync)' cli.map.json` — find async functions with 5 params
- `jq '.[] | select(.start > 7980000 and .end < 8000000)' cli.map.json` — list all functions in a region

**Input:** File path, optional `--json` (machine-readable), optional `--strings` (include string literals).

**Output (stdout, default human-readable):**
```
Function map for cli.js (11.4 MB):

  #1     char 357–500       function ySq(A,q)           async  2 params
  #2     char 520–800       function WpA()                     0 params
  ...
  #5432  char 7984321–7993406  async call({prompt:A,...},J,X,D,j)  async  5 params
  ...

Total: 8432 functions
```

**Output (--json):**
```json
[
  { "name": "ySq", "start": 357, "end": 500, "paramCount": 2, "isAsync": true, "signature": "function ySq(A,q){..." },
  ...
]
```

**Implementation:** SWC parse + full AST walk. For `--strings`, uses a nested walk within each function body collecting `StringLiteral` and `TemplateLiteral` nodes. JSON output with `--json`; human-readable table otherwise.

---

### 11. `diff-fns <file1> <file2> [--json]`

**Purpose:** Compare two versions of a minified bundle by function structure. When the SDK updates, this tells you which functions changed, moved, or were added/removed — even though all the variable names are different.

**What it does:**
1. Builds a function map for both files (same as `map` command).
2. **Fingerprints** each function using version-stable features:
   - String literals used (sorted, deduplicated)
   - AST structure hash (node types + nesting depth, ignoring identifier names)
   - Parameter count
   - Approximate body size (character count, binned to ±10%)
3. **Matches** functions across versions:
   - Exact fingerprint match → **unchanged** (just moved to a different offset)
   - Same strings + same param count but different structure hash → **modified**
   - Fingerprint in file1 only → **removed**
   - Fingerprint in file2 only → **added**
4. For modified functions, highlights what structurally changed (new branches, added/removed call sites, different string literals).
5. For patch-relevant functions, reports the offset shift: "function moved from char 7984321 → char 8102445, shift +118124".

**Why this matters:** Currently, when the SDK updates, all reverse-engineering work starts from scratch. Minified names change, char offsets shift, but the architectural patterns stay stable. This command tells you exactly what moved where, so you can update patches in minutes instead of hours.

**Input:** Two file paths, optional `--json`.

**Output (stdout):**
```
Comparing v1 (11.2 MB, 8432 functions) vs v2 (11.5 MB, 8510 functions):

Unchanged: 8200 functions (positions shifted)
Modified:  150 functions
Added:     78 functions (new in v2)
Removed:   32 functions (gone from v2)

Key changes in patch-relevant areas:

  async call({prompt:A,...}) — MODIFIED
    v1: char 7984321–7993406 (9085 chars)
    v2: char 8102445–8111800 (9355 chars, +270 chars)
    Shift: +118124
    Changes: +2 new branches, +1 new string "mode"

  function fY1(...) — UNCHANGED (moved)
    v1: char 10580668
    v2: char 10698792 (shift: +118124)
```

**Implementation:** SWC parse both files. Function fingerprinting uses a hash of `[sorted_strings, param_count, size_bin, ast_structure_hash]`. Matching is done by fingerprint equality (exact match) first, then fuzzy matching (same strings, different structure) for modified functions. AST structure hash is computed by serializing node types in DFS order, ignoring all identifier values.

---

### 12. `decompile <file> <char-offset> [--depth <N>]`

**Purpose:** Best-effort readability pass on a function — rename cryptic single-letter variables based on usage context, expand minification patterns, and add inline annotations. NOT a full decompiler, just enough to make a 200-line minified function readable without manually decoding every variable.

**What it does:**
1. Extracts the function at the given offset (via `extract-fn`).
2. Parses the extracted function with SWC.
3. Applies readability transformations:

   **Variable annotation:** For each single-letter variable, infers a descriptive name based on:
   - If it's a destructured param: use the key name (`{prompt:A}` → `A` is `prompt`)
   - If it's passed to a function with a known name: use the param name from the callee's signature
   - If it has property accesses: use the accessed properties as hints (`A.message.content` → `A` likely holds a message)
   - If it's used in a comparison with a string: use the string as a hint (`A.type==="tool_use"` → `A` is a content block)

   **Pattern expansion:**
   - `!0` → `true`, `!1` → `false`
   - `void 0` → `undefined`
   - Ternary chains: `a?b:c?d:e` → multi-line if/else (only for chains of 3+)
   - Comma expressions: `(a(),b(),c())` → separate statements

   **Inline comments:**
   - String literal context: `if(A==="tool_use")` → `if(A==="tool_use") // content block type check`
   - Known SDK patterns: `process.stdout.write(JSON.stringify(...)+"\\n")` → `// SDK transport: newline-delimited JSON`

4. If `--depth N` is specified, also decompiles the first N levels of called functions inline (useful for understanding short helper functions without switching context).

**Why this matters:** Reading `let M=Date.now(),P=await J.getAppState(),W=P.toolPermissionContext.mode` is painful. Reading `let startTime=Date.now(), appState=await session.getAppState(), permMode=appState.toolPermissionContext.mode` is not. The variable names might not be perfectly accurate, but they're good enough to understand the flow without constantly cross-referencing `scope` and `refs`.

**Input:** File path, character offset, optional `--depth N` (default 0).

**Output (stdout):**
```
Decompiled: async call({prompt:A,...},J,X,D,j) [7984321–7993406]
Confidence: medium (12/15 variables annotated)

async call({
  prompt: A,          // → prompt
  subagent_type: q,   // → subagentType
  description: K,     // → description
  model: Y,           // → model
  resume: z,          // → resume
  run_in_background: w, // → runInBackground
  max_turns: H,       // → maxTurns
  name: $,            // → name
  team_name: O,       // → teamName
  mode: _,            // → mode
}, J, /* session */ X, /* context */ D, /* message */ j /* progressCallback */) {
  let startTime = Date.now();
  let appState = await J.getAppState();      // J = session
  let permMode = appState.toolPermissionContext.mode;

  if (O && !l8())                             // l8 = isTeamsAvailable
    throw Error("Agent Teams is not yet available on your plan.");
  ...
}
```

**Implementation:** SWC parse of extracted function. Multi-pass annotation:
1. First pass: collect all identifier usages and their contexts (property accesses, function arguments, comparisons, assignments).
2. Second pass: apply heuristic naming rules based on collected context.
3. Third pass: expand minification patterns (`!0`, `void 0`, ternary chains).
4. Output pass: render with inline comments for annotations that couldn't be applied as renames (ambiguous cases).

Confidence scoring: `(annotated_vars / total_single_letter_vars) * 100`. Annotations are marked with confidence per variable (destructured = high, property-inferred = medium, guessed = low).

---

## Architecture

```
tools/minified-js-analyzer/
  cli.mjs                    ← Entry point (arg parsing, command dispatch, output formatting)
  lib/
    state-machine.mjs        ← Core: 7-state parser (normal/string/comment/regex/template)
    beautify.mjs             ← beautify(src) → { text, offsetMap }
    extract-fn.mjs           ← extractFunction(src, offset) → { signature, start, end, params, ... }
    parse.mjs                ← Shared SWC parsing: parseFile(path), parseSource(src), walkAST, collectPatternBindings
    scope.mjs                ← buildScopeTree(ast, srcLength) → { scopes, findScopeAt(offset) }
    trace-io.mjs             ← traceIO(src, pattern), findEnclosingFuncName(src, offset)
    find.mjs                 ← findInFunctions(src, pattern, options) → grouped matches
    refs.mjs                 ← findRefs(ast, src, charOffset) → external references
    calls.mjs                ← findCalls(ast, src, charOffset) → { outgoing, incoming }
    strings.mjs              ← collectStrings(src, options) → string index
    patch-check.mjs          ← checkPatch(src, pattern, replacement?) → validation result
    map.mjs                  ← buildFunctionMap(ast, src, options) → function index
    diff-fns.mjs             ← diffFunctions(map1, map2) → { unchanged, modified, added, removed }
    decompile.mjs            ← decompileFunction(ast, src, offset, options) → annotated source
  tests/
    state-machine.test.mjs
    beautify.test.mjs
    extract-fn.test.mjs
    find.test.mjs
    refs.test.mjs
    calls.test.mjs
    strings.test.mjs
    patch-check.test.mjs
    map.test.mjs
    diff-fns.test.mjs
    decompile.test.mjs
  all_requirements.md        ← This file
```

### Design Principles

1. **Lib modules export pure functions returning data objects.** No console output, no process.exit, no file I/O in lib modules (except `parse.mjs` which reads the input file). All formatting and output happens in `cli.mjs`.

2. **Two parser tiers.** Commands 1, 2, 4, 5, 8, 9 use the state machine (fast, no dependencies). Commands 3, 6, 7, 10, 11, 12 use SWC (slower but precise). Users can get quick results with state-machine commands and switch to SWC commands when they need precision.

3. **Composable building blocks.** Higher-level commands build on lower-level ones:
   - `find` uses `findFunctionStart` from extract-fn
   - `refs` uses `buildScopeTree` from scope
   - `calls` uses `parseFile` from parse + `findFunctionStart` from extract-fn
   - `map` uses `parseFile` from parse
   - `diff-fns` uses `buildFunctionMap` from map
   - `decompile` uses `extractFunction` from extract-fn + `parseSource` from parse

4. **Fail informatively.** When something doesn't work (SWC can't parse, pattern not found, offset out of range), return a structured error with suggestions rather than crashing.

### Performance Targets

| Command | Target | Notes |
|---|---|---|
| beautify | < 1s for 11MB | State machine, ~0.4s actual |
| extract-fn | < 2s for 11MB | Forward scan limited to offset + 500KB |
| find | < 2s for 11MB | State machine + indexOf |
| strings | < 2s for 11MB | State machine scan |
| patch-check | < 0.5s | Just indexOf + context |
| scope | < 5s for 11MB | SWC parse (~2.5s) + walk |
| refs | < 5s for 11MB | SWC parse + filtered walk |
| calls | < 5s for 11MB | SWC parse + full walk |
| map | < 10s for 11MB | SWC parse + exhaustive walk |
| diff-fns | < 20s | Two SWC parses + matching |
| decompile | < 5s | SWC parse of extracted function (small) |
| trace-io | < 1s | String indexOf |

### Dependency Graph

```
state-machine ← beautify ← extract-fn
                              ↑
parse ← scope ← refs         |
  ↑      ↑                   |
  |      └──── calls ────────┘
  |
  ├── map ← diff-fns
  |
  └── decompile (also uses extract-fn, beautify)

trace-io (standalone, uses findEnclosingFuncName)
strings (standalone, uses state-machine)
patch-check (standalone, uses state-machine)
find (uses extract-fn)
```
