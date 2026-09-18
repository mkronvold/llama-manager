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

- **Node.js 18+ (LTS 20.x recommended)**, installed from [nodejs.org](https://nodejs.org) or via
  `winget install OpenJS.NodeJS.LTS`.
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
