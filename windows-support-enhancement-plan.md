# Windows / PowerShell Support Enhancement Plan

Status: draft
Scope: harden `llama-manager` for native Windows + PowerShell usage (not WSL).
Owner fork: `mkronvold/llama-manager` (upstream: `bayger/llama-manager`)

## 1. Summary

Two user-reported symptoms drove this review:

1. **"No win x64 versions available"** when browsing/installing runtime versions.
2. **Extraction hangs** when a Windows asset *is* found and downloaded.

Root causes for both were identified by reading `src/lib/forks.ts`,
`src/lib/versions.ts`, `src/lib/config.ts`, and `src/lib/server.ts`. This
document lists root causes, lower-priority Windows-compatibility gaps, and a
prioritized remediation plan.

## 2. Root cause analysis

### 2.1 "No win x64 versions" — OS token allow-lists exclude Windows

`getAvailableBackends()` in `src/lib/versions.ts` filters every release asset
through:

```ts
if (!naming.osTokens.some(token => nameLower.includes(token.toLowerCase()))) continue;
```

`osTokens` is defined per-fork in `src/lib/forks.ts`. Most fork definitions
omit the `"win"` token entirely, so every Windows asset is silently dropped
before the user ever sees it:

| Fork (`FORK_REGISTRY` id) | `assetNaming.osTokens` | Windows token present? |
|---|---|---|
| `llama.cpp` (default fork) | `["ubuntu", "macos"]` | ❌ missing `"win"` |
| `beellama` | `["ubuntu", "macos"]` | ❌ missing `"win"` |
| `ik_llama` | `["ubuntu", "macos"]` | ❌ missing `"win"` |
| `koboldcpp` | `["linux", "mac"]` | ❌ missing `"win"`/`"windows"` |
| `llamacpp_rocm` | `["ubuntu", "win"]` | ✅ correct |

Since the default fork is `llama.cpp`, this explains the exact symptom
reported: real llama.cpp releases ship assets such as
`llama-b1234-bin-win-cuda-x64.zip`, but they never pass the `osTokens` check.

Additionally, `koboldcpp`'s `backendVariants[].assetMatcher` functions only
branch on `platform.startsWith("ubuntu"/"linux"/"macos")` — there is no
`win32` branch at all, even though `binaryNames.win = "koboldcpp.exe"` implies
Windows was intended to be supported. koboldcpp's real Windows assets
(`koboldcpp.exe`, `koboldcpp_nocuda.exe`, `koboldcpp_oldpc.exe`) are never
matched.

**Fix:** add `"win"` (and, defensively, `"windows"`) to every fork's
`osTokens`, and add a `platform.startsWith("win")` branch to every
`assetMatcher`, using the actual asset names published by each upstream
project (verify per-fork against their latest GitHub release before shipping).

### 2.2 Extraction hangs

Several independent issues compound to cause hangs/failures once a Windows
asset *is* resolved, in `installVersion()` (`src/lib/versions.ts`):

1. **Unbounded write-stream backpressure.** The download loop does
   `writeStream.write(value)` without awaiting `drain` when the internal
   buffer is full:
   ```ts
   while (true) {
     const { done, value } = await readerObj.read();
     if (done) break;
     ...
     writeStream.write(value);
   }
   ```
   On Windows, disk I/O for a large `.zip`/`.tar.gz` (often 200MB+) on a
   slower or antivirus-intercepted filesystem can make the write side far
   slower than the network side, causing large memory growth and apparent
   "freezes" with no progress feedback.
2. **No extraction timeout / progress signal.** `extract-zip` and `tar`
   extraction are awaited with no timeout and no incremental progress
   callback, so a stuck extraction (e.g. Windows Defender real-time
   scanning locking the just-written `.exe`) looks indistinguishable from a
   frozen UI, with no diagnostic output.
3. **Windows Defender / AV file locks on freshly extracted executables.**
   `fs.chmod(binary, "755")` and the subsequent `fs.move` of the top-level
   extracted folder can hit `EBUSY`/`EPERM` while Defender's real-time
   protection is still scanning the new `.exe`; `fs-extra` does not retry
   these transient Windows-only errors.
4. **`MAX_PATH` (260 char) issues.** Long extracted paths
   (`%LOCALAPPDATA%\llama-manager\versions\<fork>-<tag>-<backend>\...`) can
   exceed legacy Windows path limits when combined with deeply nested
   archive entries, causing `extract-zip`/`tar` to hang or fail without a
   clear error unless long-path support is enabled.
5. **`fs.chmod` on Windows is a near no-op** (Windows ACLs don't map to POSIX
   mode bits) — harmless, but worth an explicit comment so future
   contributors don't assume it grants execute permission the same way it
   does on POSIX.

**Fix:** await `drain` on backpressure, add a stall/timeout watchdog with
progress logging around extraction, retry transient Windows file-lock errors
with backoff, and opt in to long-path-safe extraction (e.g. `\\?\` prefixed
paths or shorter default install directories).

## 3. Other Windows/PowerShell compatibility gaps found in review

| Area | File | Issue | Fix |
|---|---|---|---|
| Config/data dirs | `src/lib/config.ts` | Uses XDG (`~/.config`, `~/.local/share`, `~/.local/state`, `~/.cache`) unconditionally on all platforms, including Windows. Works technically (creates dot-folders under the user profile) but is non-idiomatic and surprises Windows users/tools (not visible in `%APPDATA%`, not excluded from user profile backup/roaming policies, dot-folders are unusual on Windows). | On `win32`, default to `%APPDATA%\llama-manager` (config/state) and `%LOCALAPPDATA%\llama-manager` (data/cache), still overridable via existing `XDG_*`/`HF_HOME` env vars if explicitly set. |
| Graceful shutdown | `src/lib/server.ts` (`stopServer`) | Sends POSIX `SIGTERM` then `SIGKILL` after 5s. Node's `ChildProcess.kill()` on Windows does not deliver POSIX signals — any signal string triggers an immediate hard `TerminateProcess`, so the target binary never gets a chance to shut down gracefully (flush KV cache, close sockets) on Windows. | Detect `process.platform === "win32"` and use `taskkill /pid <pid> /T` (graceful) escalating to `taskkill /pid <pid> /T /F` (force) instead of POSIX signal names. |
| Process liveness check | `src/lib/server.ts` (`getStatus`) | Uses `process.kill(pid, 0)` to probe liveness — this works on Windows (Node polyfills it) but relies on undocumented behavior; verify/lock in a test. | Add a Windows-specific test asserting `getStatus()` liveness probing works after `startServer`. |
| Native module install | `package.json` (`better-sqlite3`) | Requires a native prebuilt binary or local MSVC build toolchain on Windows; `npm install -g` can fail without Visual Studio Build Tools / `windows-build-tools` if no prebuild matches the Node ABI. | Document required Windows prerequisites in README; pin/verify `better-sqlite3` version has Windows x64/arm64 prebuilds; consider `optionalDependencies` fallback or a pure-JS fallback path for install-only environments. |
| Terminal rendering | `package.json` (`terminal-kit`) | Known to have inconsistent behavior on legacy `cmd.exe`/older `powershell.exe` hosts (mouse mode, alternate screen buffer, true-color) versus Windows Terminal/`pwsh`. This is very likely part of "doesn't work too well for windows/powershell." | Add a documented list of supported Windows terminal hosts (Windows Terminal + PowerShell 7 recommended); file/track upstream `terminal-kit` Windows issues; add a startup capability check that warns when running in a legacy console host. |
| Binary resolution | `src/lib/forks.ts` (`resolveBinaryName`), `src/lib/server.ts` (`resolveServerBinary`) | Correctly branches on `win32` for `.exe` suffix already — no bug, but logic is duplicated in two places. | Consolidate into a single shared helper to avoid future drift between the two call sites. |
| Path separators | `src/lib/versions.ts`, `src/lib/forks.ts` | Uses `path.join`/`path.basename` consistently (good) — no raw `/`-joins found. | No fix needed; add a regression test/lint rule forbidding manual `"/"` string concatenation for filesystem paths. |
| Archive tool availability | `installVersion()` | Uses `extract-zip` (pure JS, good — no dependency on system `unzip`/`tar.exe`) — this is correct practice for Windows and should be preserved. | No fix needed; keep pure-JS extraction libraries, avoid shelling out to `tar.exe`/`Expand-Archive` for portability across older Windows builds. |

## 4. Prioritized remediation plan

**P0 — fixes the reported bugs directly**
1. Add `"win"`/`"windows"` OS tokens to all fork `assetNaming.osTokens`
   (`llama.cpp`, `beellama`, `ik_llama`, `koboldcpp`), verified against each
   upstream project's actual Windows release asset names.
2. Add Windows branches to `koboldcpp`'s `backendVariants[].assetMatcher`.
3. Add an integration test (mocked GitHub release payloads) asserting
   `getAvailableBackends()` returns non-empty Windows results for each fork
   on `platform === "win32"`.
4. Fix backpressure handling in the download loop (await `drain`).
5. Add a stall watchdog + verbose progress logging around
   `extract-zip`/`tar.extract` calls so a slow/stuck extraction is visible
   instead of appearing hung.
6. Add retry-with-backoff around post-extraction `fs.chmod`/`fs.move` calls
   for transient Windows file-lock errors (`EBUSY`, `EPERM`, `EACCES`).

**P1 — correctness/robustness on Windows**
7. Use `taskkill` instead of POSIX signal names in `stopServer()` on
   `win32`.
8. Switch default config/data/state/cache directories to
   `%APPDATA%`/`%LOCALAPPDATA%` on Windows (env var overrides still respected).
9. Add long-path support (opt into `\\?\` prefixing or document a shorter
   default install root) to avoid `MAX_PATH` extraction failures.

**P2 — polish / documentation**
10. Document Windows prerequisites (Node version, Visual Studio Build Tools
    for `better-sqlite3`, recommended terminal host) in `README.md`.
11. Add a startup capability check/warning when running under a legacy
    Windows console host lacking VT100/true-color support.
12. Consolidate duplicated `win32` binary-name branching into one shared
    helper.

## 5. Suggested test matrix

- Unit tests: `getAvailableBackends()` / `extractBackendFromAsset()` per
  fork, parameterized over `win32`/`linux`/`darwin` platform keys with
  realistic mocked asset name lists pulled from each upstream repo's actual
  latest release.
- Integration test: full `installVersion()` flow against a small local fixture
  zip/tar to validate extraction, chmod-equivalent, and folder-flattening
  logic on Windows CI (`windows-latest` GitHub Actions runner).
- Manual smoke test: run `llama-manager` in Windows Terminal + PowerShell 7
  and in legacy `powershell.exe`/`cmd.exe`, on both `win32-x64` and
  `win32-arm64` if available.

## 6. Open questions for upstream maintainer

- Should Windows support be scoped to Windows Terminal + PowerShell 7 only
  (recommended, simpler), or must legacy `powershell.exe`/`cmd.exe` also be
  first-class?
- Preference for `taskkill` shell-out vs. a native Windows job-object based
  process group kill for `stopServer()`?
- Willingness to add a Windows CI runner (`windows-latest`) to the existing
  CI pipeline to prevent regressions found in this plan from recurring?
