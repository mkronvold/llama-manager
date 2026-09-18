# llama-manager - Agent Instructions

## Quick Start

```
npm install
npm run dev       # Run with tsx (hot-reload dev loop)
npm run build     # tsup → dist/main.js (single bundled ESM output)
npm run start     # node dist/main.js
npm run lint      # tsc --noEmit (only type check, no ESLint)
```

## Important Quirks

- **ESM project** - `package.json` has `"type": "module"`.
- **Entry point is `src/main.ts`**. Has shebang `#!/usr/bin/env node`. Instantiates `LlamaManagerApp` from `src/LlamaManagerApp.ts`, which wraps a `terminal-kit` terminal (input handling only) and starts the framework's render/input loop. On Windows, `src/main.ts` also runs a startup-only console-capability check (`src/lib/termcaps.ts`) that prints a non-blocking warning if the host looks like a legacy console lacking VT100/true-color support.
- **No ESLint, no Prettier.** `npm run lint` only runs `tsc --noEmit`. That is the sole verification gate for type errors.
- **Tests use vitest** (`npm test` runs `vitest run`). Test files live under `src/lib/__tests__/`. Coverage is currently focused on Windows-specific fork/asset-matching logic and console-capability detection — most of the UI layer remains untested.
- **`dist/` is gitignored.** Must run `npm run build` before `npm run start`.
- **`npm run dev`** uses `tsx` which handles TS directly - no build step needed for development.
- **Build uses tsup** (esbuild wrapper) — single bundled ESM output. No `.js` extensions needed in imports.

## Architecture

- Terminal UI built on a custom Control-based UI framework under `src/framework/` (not `src/components/`). `LlamaManagerApp` (`src/LlamaManagerApp.ts`) manages the application lifecycle (framebuffer, render loop, input/mouse handling, fullscreen). Root control `src/ui/MainControl.ts` manages 7 tabs: Dashboard, Logs, Tasks, Profiles, Versions, Models, Options. Rendering uses a double-buffered framebuffer with diff-based terminal output (terminal-kit is used only for input handling).
- Tab navigation via number keys `1`-`7` (see the Tabs table below) and `Alt+Left`/`Alt+Right` to cycle. Status bar shows active tab name and shortcut hints.
- Tab controls live in `src/ui/tabs/`. Framework primitives (Control base class, layouts, focus manager, widgets) live in `src/framework/`. Specialized, feature-specific components live in `src/ui/specialized/` (panels, modals, lists).
- Control tree: `Control` base class (`src/framework/Control.ts`) with lifecycle hooks, child management, and dirty-flag rendering. `Layout.ts` provides flex-based `Column`/`Row`/`Group` layouts. `FocusManager.ts` singleton for Tab/Shift+Tab navigation. `ModalManager.ts` manages overlay modals.
- Widget library in `src/framework/widgets/`.
- Specialized components in `src/ui/specialized/`: `SettingsPanel` (profile preset editor), `ProfileList` (CRUD), `LogsViewer` (structured log coloring), `MetricsPanel` (per-slot metrics), `OptionsPanel` (global settings), `EditableList` (inline editable field list), `LoadedModelPanel` (loaded model info display), plus modals (`DeviceSelectorModal`, `HelpModal`, `MmprojSelectorModal`, `ModelSelectorModal`, `StoppingServerModal`, `ThemeSelectorModal`, `UpdateInfoModal`) and `TaskChartsSection`.
- Business logic in `src/lib/`: `config.ts`, `server.ts`, `forks.ts` (fork registry: asset naming/matching per platform), `logparser.ts`, `logcolors.ts`, `metricstracker.ts`, `tasks.ts`, `versions.ts` (install/extract/backend-detection), `models.ts`, `gguf.ts`, `hf.ts`, `theme.ts`, `updates.ts`, `termcaps.ts` (Windows console-capability check), `framebuffer.ts`, `framebuffer-canvas.ts`, `framebuffer-diff.ts`, `utils.ts`, `tabcontext.ts`.
- `theme.ts` loads flat theme JSONs (themes under `themes/`) — each file is `{ dark: ThemeColors, light?: ThemeColors }` with resolved hex strings, not chalk methods.
- `logcolors.ts` provides severity-based log line colorization (error/warning/info).
- `utils.ts` provides formatting helpers: `fireAsync`, `pad`, `formatMs`, `formatDuration`, `formatUptime`, `formatNum`, `formatDraftRate`, `formatDate`, `formatTime`.
- `tabcontext.ts` provides shared context (`TabContext`) extending `RenderContext` with `setTextInputFocused`, `setConfig`, and `forceRender`.
- `config.ts` manages profile-based configuration with legacy migration. Each profile has its own presets and free-form args. On `win32`, config/data/state default to `%APPDATA%\llama-manager` / `%LOCALAPPDATA%\llama-manager` (not XDG dot-folders); `migrateLegacyWindowsDirs()` auto-copies any pre-existing XDG-style data to the new location on first run. `HF_HOME`/model cache location is deliberately left unchanged across platforms to stay interoperable with real Hugging Face tooling.
- `forks.ts` centralizes per-fork (llama.cpp, koboldcpp, beellama, llamacpp_rocm, ik_llama) GitHub repo, OS token, and asset-matcher configuration used to resolve installable release assets per platform. When adding/adjusting Windows asset matching here, verify actual current asset filenames via the GitHub releases API rather than assuming a naming convention — forks are inconsistent (e.g. koboldcpp ships raw `.exe` files with no OS token at all; llama.cpp/beellama Windows CPU builds include an explicit `-cpu-` suffix that their Linux builds omit).
- `versions.ts`'s `getPlatformKey()` always returns the literal `"win"` for `win32` (never `"windows"`) — this is the real runtime value used everywhere; don't assume it will equal `"windows"` even if a fork's actual asset names use that word.
- Shared types in `src/framework/types.ts`: `Rect`, `Size`, `Point`, `RenderContext`, `ControlCallback`, `EventEmitter`.
- HTTP client is `undici` (not node-fetch).
- Config stored at `$XDG_CONFIG_HOME/llama-manager/config.json` on Linux/macOS, `%APPDATA%\llama-manager\config.json` on Windows. See SPEC.md for full schema.
- Detailed UI framework documentation in `src/framework/README.md`.

## Windows support (this fork)

This is a permanent fork (`mkronvold/llama-manager`) hardening native Windows/PowerShell usage;
Windows-specific decisions here are intentionally **fork-only and will never be proposed
upstream** to `bayger/llama-manager`. See `windows-support-enhancement-plan.md` for the full root
cause analysis and rationale behind:

- Fork asset-matching fixes for Windows release assets (`src/lib/forks.ts`).
- Download backpressure, extraction stall watchdog, and Windows-file-lock retry/backoff during
  version install (`src/lib/versions.ts`).
- `taskkill`-based graceful/forced process-tree shutdown replacing POSIX signals on `win32`
  (`src/lib/server.ts`).
- `%APPDATA%`/`%LOCALAPPDATA%` config/data/state directories with auto-migration from legacy XDG
  locations (`src/lib/config.ts`).
- Extended-length (`\\?\`) path prefixing during extraction to reduce `MAX_PATH` risk
  (`src/lib/versions.ts`).
- Legacy console capability detection/warning at startup (`src/lib/termcaps.ts`).
- Node.js runtime version compatibility check at startup (`src/lib/nodeversion.ts`) — Node 24+
  has a confirmed zlib streaming regression that hangs some zip extractions forever (see below);
  `package.json`'s `engines` field and this check flag it.
- Windows CI (`.github/workflows/windows-ci.yml`) running lint/build/test on `windows-latest`.

**Known issue root-caused in this fork**: a report of version installs hanging forever at
"Extracting..." was traced to a Node.js 24+ `zlib` inflate-stream bug (not this fork's
code) — reproduced independently of the app via a bare `extract-zip` call and a raw `yauzl`+zlib
stream with no disk I/O, both stalling at the identical byte offset; a `.NET`-based extraction of
the same entry completed instantly, ruling out data corruption. `src/lib/versions.ts`'s
`extractionStallMessage()` surfaces this explanation (with the actual `process.version`) once a
stall has run long enough that antivirus scanning alone is an unlikely explanation. See the
Windows Troubleshooting section in `README.md` for user-facing guidance.

When making further Windows-related changes, keep them isolated to this fork's own commits/branches
so periodic `git fetch upstream` syncs of unrelated (non-Windows) upstream improvements stay
low-conflict.


## Tabs

| Tab | Key | File | Description |
|---|---|---|---|
| Dashboard | 1 | `src/ui/tabs/DashboardTab.ts` | Per-slot metrics (state, speed, checkpoints), server status, Start/Stop/Restart buttons, live log viewer |
| Logs | 2 | `src/ui/tabs/LogsTab.ts` | Dedicated server log viewer with LogsViewer component |
| Tasks | 3 | `src/ui/tabs/TasksTab.ts` | Parsed task history with columns: Date, Time, Slot, Task, Prompt tokens, Output tokens, Speed, Time, Draft rate |
| Profiles | 4 | `src/ui/tabs/ServerTab.ts` | Profile list (create/rename/delete), SettingsPanel for editing presets per profile, Devices button |
| Versions | 5 | `src/ui/tabs/VersionsTab.ts` | Local llama.cpp versions, GitHub install/uninstall, active version indicator, backend selection |
| Models | 6 | `src/ui/tabs/ModelsTab.ts` | Local GGUF models, HF browse/search, download with progress, set active, delete |
| Options | 7 | `src/ui/tabs/OptionsTab.ts` | Global app settings: paths, dashboard poll interval, task limits, appearance, theme, HF token |

## Dependencies

Uses terminal-kit 3 (input only), better-sqlite3, undici 7, TypeScript 5, fs-extra 11, chalk 4, tsup (bundler), vitest (test runner). No React, no Ink. APIs may differ from tutorials referencing older stacks - check current documentation on the web before following stale examples.

## Conventions

- No JSX. All rendering is imperative via `FramebufferCanvas` (double-buffered framebuffer, diff-based terminal output).
- Controls own presentation state (selectedIndex, scrollOffset, editValue); business data passed via config/props.
- Dirty flags (`needsRender`) enable incremental rendering without full-tree redraw.
- Two-pass layout: `measure()` reports desired size, `onLayout()` assigns child rects.
- `FocusManager` singleton tracks single focus point; Tab/Shift+Tab navigation through focusable controls.
- Cursor visibility via ANSI escapes (`\x1b[?25h`/`\x1b[?25l`) - `terminal-kit`'s `Terminal` type lacks `showCursor`/`hideCursor`.
- Strict TypeScript. No loose `any` patterns - follow existing typing.
- Follow the directory structure from SPEC.md. New features go under `src/ui/tabs/`, `src/ui/specialized/`, or `src/lib/`.
- Tabs use factory functions (`createXxxTab(ctx)`) that return either a `Control` or a legacy `TabModule`. App wraps Controls automatically.
- `fireAsync` from `utils.ts` should be used for async button handlers - it catches errors and shows them via the provided app's `showMessage`.

## Important

- DO NOT COMMIT or PUSH without permission
- Only commit or push when explicitly asked