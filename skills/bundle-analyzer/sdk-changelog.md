# @anthropic-ai/claude-agent-sdk Changelog: 0.2.39 → 0.2.40

- Claude Code version: **2.1.39 → 2.1.40**
- Build date: **2026-02-10 → 2026-02-12**
- cli.js: **11.45 MB → 11.47 MB** (+23KB, 130 added fns, 80 removed, 128 modified)
- sdk.mjs: **377 KB → 377 KB** (2 functions changed — version bump + session state)

## Key Changes

### 1. Better Bedrock/non-firstParty Model Error Messages

New `PE7` function suggests alternative models when a model isn't available on Bedrock or third-party deployments:

- If the failing model contains `opus-4-6`/`opus_4_6`, it suggests switching to Opus
- If it contains `sonnet-4-5`/`sonnet_4_5`, it suggests Sonnet
- Error messages now say `"Try --model to switch to <suggestion>"` instead of generic `"Use --model to pick a different model"`
- 404 errors now say `"The model X is not available on your <deployment>. Try --model to switch to <suggestion>, or ask your admin to enable this model."`

### 2. Sandbox: `enableWeakerNetworkIsolation` Option

New config option `enableWeakerNetworkIsolation` for the macOS sandbox profile:

- Allows access to `com.apple.trustd.agent` (needed for Go TLS certificate verification)
- Described as *"Enable weaker network isolation to allow access to com.apple.trustd.agent (may improve compatibility)"*
- Threaded through the sandbox builder function chain (`OG5` → `G17` → `vG5`)

### 3. New `manifest.zst.json` File

A new compressed manifest format with Zstandard-compressed binaries:

- Same platform list as `manifest.json` but binaries named `claude.zst` / `claude.exe.zst`
- Significantly smaller sizes (e.g., darwin-arm64: 183MB → 39MB compressed)
- Both `win32-x64` and new `win32-arm64` platform entries (arm64 has size=0, likely placeholder)

### 4. Session State: `promptCache1hAllowlist`

New field added to the global session state object:

- `promptCache1hAllowlist: null` — getter (`jy6`) and setter (`Dy6`) functions added
- Described as an allowlist for 1-hour prompt caching; accepts model IDs. If undefined, all models are available; if empty array, only the default model

### 5. New Telemetry Events

- `cli_streaming_idle_timeout` / `cli_streaming_idle_warning` — streaming idle detection
- `tengu_immediate_command_executed` — immediate command tracking
- `tengu_streaming_idle_timeout` — server-side idle timeout tracking

### 6. Removed Strings/Features

- `(ctrl+y to copy)` — removed from UI
- `Preferences about how steps should work` — removed from skill/auto-memory prompts
- `No stable tool found for cache marker, falling back to system prompt caching` — cache marker fallback removed
- `tengu_bypass_permissions_mode_dialog_shown` / `tengu_bash_command_interrupt_backgrounded` / `tengu_skill_improvement_detected` — old telemetry events removed
- `x-anthropic-billing-header` — billing header reference removed
- `Task files are allowed for writing` / `Team files are allowed for writing` — removed messages

### 7. Minor Changes

- `/rename` error message changed from `"Please provide a name"` → `"Could not generate a name: no conversation context yet"`
- New UI strings: `"Log out from your Anthropic account"`, `"Show authentication status"`, `"Sign in to your Anthropic account"`, `"Output as human-readable text"`, `"Pre-populate email address on the login page"`
- `bubblewrap (bwrap) not installed` — new Linux sandbox detection message
- `bypassPermissionsModeAccepted` / `disableBypassPermissionsMode` config options restructured
- `sdk.d.ts` — trivial whitespace change only (one blank line added)
