# Claude Code Permission Rules — Complete Reference

## Settings Files

Permissions are configured in the `permissions` property of settings JSON files. Multiple files are loaded and their rules are **merged additively** (not replaced) — each source maintains its own list of rules, and all are checked:

| # | File | Key | Description |
|---|---|---|---|
| 1 | `~/.claude/settings.json` | `userSettings` | User-global, applies to all projects |
| 2 | `.claude/settings.json` | `projectSettings` | Project-level, committed to repo |
| 3 | `.claude/settings.local.json` | `localSettings` | Project-level, gitignored by convention |
| 4 | CLI `--allowedTools` / `--disallowedTools` | `cliArg` | Per-invocation |
| 5 | Session (user clicks "Always allow") | `session` | Runtime, lost on session end |

Additionally, managed/enterprise environments may have `policySettings` and `flagSettings` that take priority.

**Merging behavior:** Rules from ALL sources are collected into a flat list. A deny rule from `userSettings` and an allow rule from `localSettings` both apply — deny wins by evaluation order, not by source priority. The sources don't override each other; they accumulate.

## The `permissions` Object Schema

```json
{
  "permissions": {
    "allow": ["Rule1", "Rule2"],
    "deny": ["Rule3"],
    "ask": ["Rule4"],
    "defaultMode": "default",
    "additionalDirectories": ["/other/path"],
    "disableBypassPermissionsMode": "disable"
  }
}
```

| Key | Type | Description |
|---|---|---|
| `allow` | `string[]` | Rules for auto-allowed operations |
| `deny` | `string[]` | Rules for auto-denied operations |
| `ask` | `string[]` | Rules that **always prompt**, even if a broader allow rule matches |
| `defaultMode` | enum | Default permission mode for the session |
| `additionalDirectories` | `string[]` | Extra directories the session can access beyond cwd |
| `disableBypassPermissionsMode` | `"disable"` | Prevents using bypass permissions mode |

### `defaultMode` values

| Value | Behavior |
|---|---|
| `"default"` | Normal: check rules, prompt when no rule matches |
| `"bypassPermissions"` | Auto-allow everything (can be disabled by org policy) |
| `"plan"` | Plan mode: allows if bypass is available |
| `"dontAsk"` | Auto-deny anything that would normally prompt (headless/CI) |
| `"acceptEdits"` | Auto-allow file edits, prompt for other tools |
| `"delegate"` | Agent swarm mode (requires feature flag) |

### `additionalDirectories`

An array of absolute paths the session can access beyond the working directory. File tools (Read/Edit/Write/Glob) deny access to paths outside `cwd` + `additionalDirectories` regardless of allow rules. This is a hard security boundary.

### `ask` array

The `ask` array forces a confirmation prompt even if a broader allow rule would auto-approve. Example:

```json
{
  "permissions": {
    "allow": ["Bash(git:*)"],
    "ask": ["Bash(git push:*)", "Bash(git reset:*)"]
  }
}
```

This auto-allows all git commands **except** `git push` and `git reset`, which always prompt.

## Rule String Format

Every rule is a string: `"ToolName"` or `"ToolName(content)"`.

### Parsing rules

1. Find the **first** `(` and **last** `)` in the string
2. If `)` is not the last character → treat entire string as bare tool name
3. `toolName` = everything before `(`
4. `ruleContent` = everything between `(` and `)`
5. If ruleContent is empty or `"*"` → equivalent to bare tool name (matches all uses)
6. Parentheses inside content must be escaped: `\(` and `\)`. Backslashes: `\\`

### Multiple rules in one string

Rules can be comma or space separated within a single string. Content inside `()` is preserved:

```json
["Bash(npm:*), Edit, Read(src/**)"]
→ ["Bash(npm:*)", "Edit", "Read(src/**)"]
```

### Tool-level vs content-specific rules

- **`"Edit"`** (bare name, no content) = **tool-level rule** — matches ALL uses of that tool
- **`"Edit(src/**)`** (with content) = **content-specific rule** — matches only when the tool's input matches the pattern

## Evaluation Order (Master Permission Check)

When any tool is invoked, the SDK runs this decision flow:

```
1. Tool-level deny (bare name in deny, e.g., "Edit")         → DENY
2. Tool-level ask  (bare name in ask)                         → ASK
3. Tool's own checkPermissions()
   - Evaluates content-specific rules: deny → ask → allow
   - Enforces working directory boundary (paths outside → DENY)
   - Tool-specific logic (Bash: command injection check, etc.)
   → returns: deny / ask / allow / passthrough
4. If step 3 returned deny                                   → DENY (hard stop)
5. If mode is "bypassPermissions"                             → ALLOW
6. Tool-level allow (bare name in allow, e.g., "Edit")        → ALLOW
7. Default                                                    → ASK (prompt user)
```

### Key implications

- **Bare tool name in allow skips content matching.** If `checkPermissions` at step 3 returned "ask" (no content-specific rule matched), the tool-level allow at step 6 overrides it. Example: bare `"Edit"` in allow auto-allows editing any file within allowed directories without needing path-specific rules.
- **Working directory is still enforced.** Paths outside `cwd` + `additionalDirectories` return deny at step 3, caught at step 4. Bare `"Edit"` in allow does NOT bypass the working directory boundary.
- **deny > ask > allow.** A deny rule always wins. An `ask` rule forces a prompt even if a broader allow rule exists.
- **Content-specific rules are relative to cwd.** For file tools, `"Edit(src/**)"` means `<cwd>/src/**`.

---

## Tool-by-Tool Reference

### Bash

The ruleContent is matched against the **command string**. There are three match types, determined automatically by the ruleContent format:

#### 1. Prefix match — ruleContent ends with `:*`

Everything before `:*` is the prefix. The command must exactly equal the prefix, OR start with `prefix + " "`. Also matches `xargs <prefix>` and `xargs <prefix> <args>`.

| Rule | Matches | Does NOT match |
|---|---|---|
| `Bash(npm:*)` | `npm`, `npm install`, `npm run dev` | `npx create-app` |
| `Bash(git:*)` | `git`, `git status`, `git commit -m "x"` | `gitk` |
| `Bash(bundle-analyzer.cmd:*)` | `bundle-analyzer.cmd find ...` | `bundle-analyzer find` |
| `Bash(cd:*)` | `cd`, `cd /path/to/dir` | `cdr something` |

#### 2. Wildcard match — ruleContent contains `*` (but doesn't end with `:*`)

`*` becomes `.*` in a regex, anchored with `^...$`. Other regex special chars are escaped. Use `\*` for a literal star.

| Rule | Matches | Does NOT match |
|---|---|---|
| `Bash(git commit *)` | `git commit -m "foo"`, `git commit --amend` | `git status` |
| `Bash(python *.py)` | `python test.py`, `python main.py` | `python -m pytest` |
| `Bash(rm -rf *)` | `rm -rf /tmp`, `rm -rf node_modules` | `rm file.txt` |

**Note:** Wildcard rules are only checked in the prefix-match pass, not the exact-match pass.

#### 3. Exact match — ruleContent has no `*`

The command must be the exact same string.

| Rule | Matches | Does NOT match |
|---|---|---|
| `Bash(npm install)` | `npm install` | `npm install lodash` |
| `Bash(git status)` | `git status` | `git status --short` |
| `Bash(ls)` | `ls` | `ls -la` |

#### Bash two-pass matching

For each command/subcommand, rules are checked in two passes:

1. **Exact pass:** Only exact-match rules are tested (prefix and wildcard rules are skipped). Checks deny → ask → allow.
2. **Prefix pass:** Prefix-match and wildcard rules are tested. Checks deny → ask → allow.

If the exact pass returns deny/ask/allow, it wins. The prefix pass only runs if the exact pass returned "passthrough" (no match).

#### Compound commands (`&&`, `||`, `;`, `|`)

Commands are **split into subcommands**, each checked independently:

```
cd /project && npm install && npm test
→ subcommands: ["cd /project", "npm install", "npm test"]
```

- `cd <exact-working-directory>` is **auto-filtered** (silently dropped) — but only if the path string exactly matches the SDK's internal working directory (see Windows Path Gotcha below)
- Pipe chains (`|`) are split and each side is checked via recursive calls
- **Any** subcommand denied → whole command denied
- **All** subcommands allowed → whole command allowed
- **Any** subcommand is "ask" → user is prompted for the whole command

#### Bash command normalization

Before matching, the command is normalized. Both original and normalized forms are tested:

1. **Redirections stripped:** `2>/dev/null`, `> file.txt`, `< input`, `2>&1` are removed
2. **Known-safe env var prefixes stripped:** `NODE_ENV=production npm start` → `npm start`. Whitelist includes: `NODE_ENV`, `RUST_LOG`, `RUST_BACKTRACE`, `PYTHONUNBUFFERED`, `PYTHONDONTWRITEBYTECODE`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, and others.
3. **Command wrappers stripped:** `timeout 30s npm test` → `npm test` (also `time`, `nice -n N`, `nohup`)

#### Bash command injection check

**Important:** Even after a rule matches and returns "allow", the SDK runs a command injection security check. If the check flags suspicious patterns (unusual quoting, command substitution, etc.), it can **override the allow back to "ask"**, forcing a prompt. This is by design and cannot be disabled by permission rules. The env var `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` can disable it.

#### Bash read-only auto-allow

Commands the SDK considers "read-only" (e.g., `ls`, `cat`, `head`, `pwd`, `which`, `echo`) are auto-allowed in certain flows without needing explicit rules, provided they don't trigger other checks (working directory, injection).

#### Bash sandbox auto-allow

When sandbox is enabled with `autoAllowBashIfSandboxed`, commands running inside the sandbox are auto-allowed (after deny/ask rules are checked). This means sandboxed commands only need deny rules to block them — they don't need explicit allow rules.

#### Example trace

```
Command: cd /d/WorkPlace/ClaudeUI && bundle-analyzer.cmd find cli.js "allow" --compact 2>/dev/null
```
1. Split on `&&`: `cd /d/WorkPlace/ClaudeUI` + `bundle-analyzer.cmd find cli.js "allow" --compact 2>/dev/null`
2. `cd /d/WorkPlace/ClaudeUI` filtered (exact match with working dir)
3. Remaining: `bundle-analyzer.cmd find cli.js "allow" --compact 2>/dev/null`
4. Redirections stripped: `bundle-analyzer.cmd find cli.js "allow" --compact`
5. No wrappers/env vars to strip
6. Exact pass: no exact rule matches → passthrough
7. Prefix pass: `Bash(bundle-analyzer.cmd:*)` → prefix `bundle-analyzer.cmd` → command starts with `bundle-analyzer.cmd ` → **ALLOW**

---

### Read / Edit / Write / Glob / NotebookRead / NotebookEdit

All file tools share the same path-matching system. They are in the `filePatternTools` group. The ruleContent is a **gitignore-style glob pattern** matched against the file/directory path.

#### How the path is determined per tool

| Tool | Input field checked |
|---|---|
| `Read`, `Edit`, `Write` | `file_path` parameter |
| `Glob` | `path` parameter (the search directory, not individual results) |
| `NotebookRead`, `NotebookEdit` | `notebook_path` parameter |

#### Matching logic

1. The file path is resolved to absolute
2. On Windows, backslashes are normalized to forward slashes
3. The path is made relative to each allowed working directory
4. The relative path is tested against the pattern using the `ignore` npm library (same engine as `.gitignore`)

#### Pattern examples

| Rule | Matches | Does NOT match |
|---|---|---|
| `Edit(src/**)` | `src/index.ts`, `src/utils/helper.ts` | `test/index.ts` |
| `Read(*.json)` | `package.json`, `src/config.json` | `data.txt` |
| `Edit(**/*.test.ts)` | `src/foo.test.ts`, `tests/bar.test.ts` | `src/foo.ts` |
| `Read(**)` | Everything under working dir | Paths outside working dir |
| `Glob(node_modules/**)` | Glob searching in `node_modules/` | Glob searching in `src/` |
| `Write(src/**)` | Writing any file under `src/` | Writing to `dist/` |

#### Gitignore pattern semantics

- `*` matches within a single directory level
- `**` matches across directory levels
- `/` prefix anchors to the root (working directory)
- A pattern without `/` (like `*.json`) matches at any directory level (equivalent to `**/*.json`)
- A pattern with `/` (like `src/*.json`) only matches in that specific directory
- `src/**` matches everything under `src/` at any depth

#### Working directory enforcement

Paths outside `cwd` + `additionalDirectories` are **always denied** regardless of allow rules. This is enforced inside `checkPermissions` and returns deny, which is a hard stop at step 4 of the master flow. Even a bare `"Edit"` in allow cannot bypass this.

---

### WebFetch

The ruleContent **must** use the `domain:` prefix. Raw URLs and other formats are rejected with a helpful error message.

**Matching logic:** The hostname is extracted from the fetched URL and compared against the domain pattern.

| Rule | Matches | Does NOT match |
|---|---|---|
| `WebFetch(domain:example.com)` | `https://example.com/page` | `https://sub.example.com` |
| `WebFetch(domain:*.github.com)` | `https://api.github.com/repos` | `https://github.com/foo` |
| `WebFetch(domain:github.com)` | `https://github.com/foo` | `https://api.github.com` |

Bare `"WebFetch"` in allow auto-allows fetching from any domain.

There is also a hardcoded preapproved host list (Anthropic domains) checked before user rules.

---

### WebSearch

A custom validator **rejects `*` and `?`** in WebSearch ruleContent — wildcards are not supported. Use bare `"WebSearch"` for tool-level allow/deny.

---

### Skill

The ruleContent is matched against the **skill name** (identifier like `commit`, `review-pr`). A leading `/` in the skill name is stripped before matching.

| Rule | Matches | Does NOT match |
|---|---|---|
| `Skill(commit)` | `/commit` skill | `/review-pr` skill |
| `Skill(review:*)` | Any skill starting with `review` | `/commit` skill |

The `:*` suffix is a prefix match (same as Bash). Without `:*`, it's exact match only.

---

### MCP Tools

MCP tool names follow the format `mcp__<server>__<tool>`.

| Rule | Matches |
|---|---|
| `mcp__myserver__mytool` | Exactly that one MCP tool |
| `mcp__myserver__*` | All tools from `myserver` |

The server-wide wildcard (`__*`) checks that the server name matches and treats the tool name as wildcarded. This is checked at the tool-level matching stage (step 1/2/6), not inside `checkPermissions`.

---

### Task (Subagent)

Task/subagent permissions use tool-level matching. The ruleContent is the `agentType`:

| Rule | Matches |
|---|---|
| `Task` | All subagent invocations |
| `Task(Bash)` | Only Bash-type subagents |
| `Task(Explore)` | Only Explore-type subagents |

---

## Settings Reload Behavior

### CLI (`claude` command) — Hot Reload: YES

The CLI uses **chokidar** to watch all settings files. On file change:

1. Chokidar detects the change (1000ms write-finish stabilization, polling at 500ms)
2. Settings are re-read from disk (no cache — reads fresh every time)
3. The `toolPermissionContext` is rebuilt with new rules
4. An "own write" check prevents reload loops when the SDK itself writes settings (5s cooldown)

Changes take effect within ~1-2 seconds without restarting the session.

### SDK `query()` API (ClaudeUI, custom integrations) — Hot Reload: NO

The file watcher is **only initialized from the CLI's startup function**, not from the `query()` API. This means:

- Settings are loaded **once at session start**
- Mid-session changes to settings files are **never picked up**
- You must **start a new session** for changes to take effect
- The `canUseTool` callback only fires when the SDK returns "ask" — auto-allowed/denied tools never hit the callback

### `.gitignore` — No Effect on Loading

The settings loader reads files directly via `existsSync` + `readFileSync`. `.gitignore` is irrelevant. The "local" in `settings.local.json` is a naming convention only.

### Invalid JSON

If a settings file contains invalid JSON, it is silently ignored (treated as no settings). The SDK uses Zod schema validation — properties not in the schema are passed through (`.passthrough()`).

---

## Windows Path Gotcha

On Windows with Git Bash, the SDK's internal working directory uses POSIX format (`/d/WorkPlace/Project`), not Windows format (`D:/WorkPlace/Project` or `D:\WorkPlace\Project`).

The SDK auto-filters `cd <working-dir>` from compound commands by **exact string match**:

```
if (subcommand === `cd ${workingDir}`) → filter out
```

So `cd D:/WorkPlace/Project` does NOT match `cd /d/WorkPlace/Project` and becomes an unmatched subcommand, triggering a permission prompt — even if the actual tool command has a matching allow rule.

**Fix:** Don't use `cd` prefixes (commands already run in cwd). If a path must appear in a command, use POSIX format: `/d/WorkPlace/Project`.

---

## Quick Decision Guide

| Scenario | Rule |
|---|---|
| Allow all Bash commands | `Bash` |
| Allow a CLI tool + all subcommands | `Bash(toolname:*)` |
| Allow a specific command with any args | `Bash(command *)` (wildcard) |
| Allow one exact command only | `Bash(exact command here)` |
| Allow editing any file (within cwd) | `Edit` |
| Allow editing files in a subdirectory | `Edit(dirname/**)` |
| Allow reading all files | `Read` |
| Allow reading specific file types | `Read(*.ext)` |
| Allow globbing anywhere (within cwd) | `Glob` |
| Allow all file operations (within cwd) | `Read`, `Edit`, `Write`, `Glob` (separate rules) |
| Allow fetching from a domain | `WebFetch(domain:hostname)` |
| Allow fetching from all subdomains | `WebFetch(domain:*.hostname)` |
| Allow all web fetching | `WebFetch` |
| Allow a specific MCP server | `mcp__servername__*` |
| Allow all subagents | `Task` |
| Force prompt for dangerous command | In `ask`: `Bash(git push:*)` |
| Block a dangerous pattern | In `deny`: `Bash(rm -rf *)` |
| Expand file access beyond cwd | `"additionalDirectories": ["/other/path"]` |

## Full Example

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(bun:*)",
      "Bash(npm:*)",
      "Bash(node:*)",
      "Bash(npx:*)",
      "Bash(cd:*)",
      "Bash(bundle-analyzer.cmd:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(wc:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(which:*)",
      "Bash(echo:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
      "Bash(touch:*)",
      "Bash(curl:*)",
      "Bash(gh:*)",
      "Bash(python:*)",
      "Bash(python3:*)",
      "Edit",
      "Read",
      "Write",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "mcp__lsphub__*"
    ],
    "deny": [
      "Bash(rm -rf /*)"
    ],
    "ask": [
      "Bash(git push:*)",
      "Bash(git push --force:*)"
    ]
  }
}
```

This config auto-allows most development commands, prompts on `git push`, and blocks `rm -rf /`. All file operations are allowed within the working directory. Web access is unrestricted.
