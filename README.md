# llama-manager

![latest release](https://img.shields.io/github/v/release/bayger/llama-manager?style=flat-square&label=latest&color=549e6a)
![license](https://img.shields.io/badge/license-Apache%202.0-549e6a?style=flat-square)

A terminal UI for managing [llama.cpp](https://github.com/ggml-org/llama.cpp) — start and control the server, manage versions, download GGUF models from Hugging Face, and monitor inference performance in real time.

![llama-manager demo](./demo.gif)

## Install

```bash
npm install -g llama-manager
llama-manager
```

Requires Node.js 18+ and a llama.cpp binary (managed via the Versions tab or installed manually).

### Windows

This is a fork ([mkronvold/llama-manager](https://github.com/mkronvold/llama-manager)) hardened
for native Windows/PowerShell usage; see `windows-support-enhancement-plan.md` for the full
rationale. Prerequisites and recommendations:

- **Use Node.js 22.x** (or any 18–22 release). **Avoid Node.js 24+**: it has a confirmed zlib
  streaming regression that can make version installs hang forever mid-extraction on some zip
  entries (see Troubleshooting below). `package.json` declares `"engines": { "node": ">=18 <23" }`
  and the app prints a startup warning if it detects an untested Node major version.
  ⚠️ **Don't rely on `winget install OpenJS.NodeJS.LTS`** or downloading "LTS" from nodejs.org as
  of late 2025 — Node.js 24 became the current LTS line (Oct 2025), so that alias/label now
  installs the very version with this bug. Instead, pin an explicit Node 22.x install:
  - Recommended: install a Node version manager — [nvm-windows](https://github.com/coreybutler/nvm-windows)
    (`winget install CoreyButler.NVMforWindows`) or [fnm](https://github.com/Schniz/fnm)
    (`winget install Schniz.fnm`) — then `nvm install 22.23.2 && nvm use 22.23.2` (or the fnm
    equivalent). This also makes it easy to switch back once the Node 24+ zlib bug is fixed
    upstream.
  - Alternative: download a specific 22.x installer directly from
    [nodejs.org/download/release/latest-v22.x](https://nodejs.org/download/release/latest-v22.x/)
    rather than the site's generic "LTS" download button.
- **Visual Studio Build Tools** (the "Desktop development with C++" workload, or at minimum the
  "C++ build tools" component) are required the first time `npm install` compiles the
  `better-sqlite3` native module, unless a prebuilt binary is available for your Node/arch
  combination. Install via `winget install Microsoft.VisualStudio.2022.BuildTools` or the
  [Visual Studio installer](https://visualstudio.microsoft.com/downloads/).
- **Terminal host**: [Windows Terminal](https://aka.ms/terminal) with **PowerShell 7 (`pwsh`)** is
  the recommended and best-tested combination (proper VT100/true-color and mouse support). Legacy
  `cmd.exe` or Windows PowerShell 5.1 in the classic console host will work but may render themes
  and colors incorrectly — llama-manager prints a one-time warning at startup if it detects this.
- Config/data/state directories default to `%APPDATA%\llama-manager` and
  `%LOCALAPPDATA%\llama-manager` on Windows (see Storage below); existing data from a previous
  XDG-style install is migrated automatically on first run.

#### Troubleshooting: a version install hangs forever at "Extracting..."

If the Versions tab gets stuck at `Extracting...` and never finishes (even after several
minutes, with the progress percentage frozen), this is very likely **not** disk speed or
antivirus — it's a confirmed Node.js 24+ bug where the built-in `zlib` module's inflate stream
can stall indefinitely partway through decompressing certain larger zip entries (e.g. the Vulkan
backend's `ggml-vulkan.dll`, which bundles a large amount of compiled SPIR-V shader data).

This was root-caused by reproducing the hang three independent ways, all stalling at the exact
same byte offset regardless of antivirus, disk, or this app's own code: a full install through
this app, a bare `extract-zip` call outside the app, and a raw `yauzl` + Node `zlib` read stream
with no disk writes involved at all. A `.NET`-based extraction of the same zip entry, by contrast,
completed instantly — confirming the zip data itself isn't corrupted.

**Fix**: run `node --version`; if it reports v24 or newer, install a Node version manager and
switch to Node 22.x — the "LTS" label alone is no longer a safe indicator (see the prerequisites
note above). With nvm-windows:
```powershell
winget install CoreyButler.NVMforWindows
# open a new terminal window so PATH changes take effect, then:
nvm install 22.23.2
nvm use 22.23.2
npm install -g llama-manager   # or: npm install -g "<path to your local clone>"
```
Verify with `node --version` (should print `v22.x.x`) before retrying the version install.

## CLI usage

```
llama-manager          # launch the interactive TUI
llama-manager --stop    # stop a server left running in the background, without launching the TUI
```

Choosing **Exit Now** in the Exit dialog (when a server is running) leaves the server running
detached in the background instead of stopping it — the TUI just closes. Run `llama-manager`
again to resume managing it (it will show as already running), or run `llama-manager --stop` to
stop it without reopening the TUI. Choosing **Stop & Exit** instead stops the server gracefully
before closing.

## Features

- **Dashboard** — real-time per-slot metrics, server controls (start/stop/restart), loaded model info, and recent-task charts
- **Logs** — dedicated server log viewer with structured severity coloring
- **Tasks** — parsed task history with token counts, speeds, draft acceptance, sorting, SQLite persistence, and aggregated charts (tasks/tokens over time)
- **Profiles** — named server configurations with type-aware preset editors and free-form arguments
- **Versions** — install, switch, and uninstall llama.cpp builds; browse releases, select backend and fork, view changelogs
- **Models** — search Hugging Face, download GGUF models with progress tracking, set active, delete
- **Options** — global settings: paths, poll interval, task limits, appearance, theme, HF token, fork selection, update checks

## Navigation

| Key | Action |
|---|---|
| `1`-`7` | Switch tabs |
| `Alt+Left` / `Alt+Right` | Cycle tabs |
| `Tab` / `Shift+Tab` | Move focus |
| `Enter` | Confirm / select |
| `Esc` | Cancel |
| `?` | Show help |
| `Ctrl+T` | Open theme selector |
| `Ctrl+D` | Toggle dark/light mode |
| `Ctrl+U` | Check for updates |
| `q` | Quit |
| Mouse click | Select tabs, list items, buttons |
| Mouse scroll | Scroll in log viewer, tables, lists |

## Tabs

| Tab | Key | Description |
|---|---|---|
| Dashboard | 1 | Per-slot metrics, server controls, model info, recent-task charts |
| Logs | 2 | Dedicated server log viewer |
| Tasks | 3 | Parsed task history, aggregated charts view |
| Profiles | 4 | Profile management, preset editing |
| Versions | 5 | Local versions, GitHub releases, backend & fork selection, changelog |
| Models | 6 | Local GGUFs, HF browse, download, delete |
| Options | 7 | Global app settings |

## Storage

Follows the XDG Base Directory spec on Linux/macOS. On Windows, uses idiomatic
`%APPDATA%`/`%LOCALAPPDATA%` locations instead; legacy XDG-style data from a previous install is
auto-migrated the first time the new locations are used. All paths configurable in Options, and
still overridable via `XDG_*_HOME` env vars if explicitly set.

| What | Linux/macOS Default | Windows Default |
|---|---|---|
| Config | `~/.config/llama-manager/config.json` | `%APPDATA%\llama-manager\config.json` |
| Versions | `~/.local/share/llama-manager/versions/` | `%LOCALAPPDATA%\llama-manager\versions\` |
| Models | `~/.cache/huggingface/llama-manager/` | `~/.cache/huggingface/llama-manager/` (unchanged — matches Hugging Face tooling's own cross-platform default) |
| Tasks DB | `~/.local/share/llama-manager/tasks.db` | `%LOCALAPPDATA%\llama-manager\tasks.db` |
| Server log | `~/.local/state/llama-manager/logs/server.<timestamp>.log` | `%LOCALAPPDATA%\llama-manager\state\logs\server.<timestamp>.log` |


## Themes

31 bundled themes including Catppuccin, Dracula, Gruvbox, Nord, Tokyo Night, and more. Each theme supports dark and light variants. Selectable from the Options tab.

## Tech Stack

TypeScript, terminal-kit (input only), undici, better-sqlite3, custom Control-based UI framework with double-buffered framebuffer rendering (no React, no Ink).

## License

Apache License 2.0
