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
llama-manager --stop    # stop a server (llama.cpp or Strata) left running in the background, without launching the TUI
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
- **Profiles** — named server configurations with type-aware preset editors and free-form arguments; Strata profiles bound to a registered installation, with Check/Configure tool runs
- **Versions** — install, switch, and uninstall llama.cpp builds; browse releases, select backend and fork, view changelogs; register and inspect existing Windows Strata installations
- **Models** — search Hugging Face, download GGUF models with progress tracking, set active, delete
- **Options** — global settings: paths, poll interval, task limits, appearance, theme, HF token, fork selection, update checks

### Strata registration and profiles (Windows)

In **Versions**, choose **Register Strata** and enter the absolute folder of an
existing [Strata](https://github.com/Niko1221/Strata) source installation prepared
by its own setup tooling. Registration checks the private `.venv\Scripts\python.exe`
and imports, source Git identity, `engine\BUILD.json`, and generated `strata-*.json`
configs, including tokenizer, pack, library and GGUF shard paths. It does not
run setup, download models, or launch inference.

The table shows source tag and engine version separately. Select the Strata row
to see inspection diagnostics; incomplete installations remain visible but are
not usable. **Unregister** removes only the manager registration and preserves
all source, environment, model and pack files; it lists any profiles that use the
installation, which then show "installation not registered" until re-bound.
Generic **Update** is unavailable; **Update All** excludes Strata because source
and engine updates belong to upstream tooling.

In **Profiles**, **Create** asks for a runtime. Choosing **Strata** picks a
registered installation and one of its generated configs (auto-selected when
there is only one), then a profile name. A Strata profile is an ordinary profile
plus that binding: Duplicate, Rename and Delete work as usual. Only the service
**host**, **port** and **API key** are editable; host/port are copied from the
active profile unless unset or still the llama defaults, in which case Strata's
default `0.0.0.0:1234` is used. A non-loopback bind without any API key shows an
exposure warning. Model, backend, context, KV, cache and speculative settings are
shown read-only from the generated config; **Strata Config** switches between
that installation's configs.

**Check** (`setup.py --check`) and **Configure** (`setup.py --setup --no-start
--no-browser --models-dir <manager models folder>`) open upstream tooling in a separate PowerShell window from the
installation folder. Configure passes the manager's models folder because
upstream does not remember it; without it, setup would download a second copy
into `<Strata data>\models` instead of reusing existing GGUFs. The manager never passes `--yes`. Run status survives a
manager restart: a closed window without an exit code is shown as abandoned, a
non-zero exit as failed, and Configure is only reported completed if a usable
config is found afterwards. Only one Configure per installation runs at a time.
New configs appear in the config selector; existing profiles are not rebound.

Setup regenerates the config on every Configure and drops options it does not
choose, so llama-manager carries the bound config's `--vram-reserve-mib` into
setup and, after a successful run, reapplies tuning to the configs it wrote:
`--prefill auto:32768` (64 GiB+ RAM), `--conversation-cache-mib 8192` (86 GiB+
RAM), and the whole KV cache in VRAM (`--kv-resident` removed) only when the
last load since boot held every expert in VRAM with room left for the cache.
Otherwise KV streaming is kept. The changes are listed when Configure finishes.

With a Strata profile active, Dashboard shows the bound installation instead of a
version, the Models tab does not change the active model/mmproj (the Strata model
is chosen by Configure), and device scanning is replaced by Check/Configure.
Existing llama.cpp profiles and the active version are unchanged.

### Strata service lifecycle (Windows)

**Start** launches the installation's Python service on the profile's host/port
(refused if that port is already listening) and loads the model. The profile API
key, if set, is passed in the `STRATA_API_KEY` environment variable, never on the
command line; otherwise Strata's own configured key applies. Only one session
(llama.cpp or Strata) runs at a time. The Loaded Model panel shows model, backend,
context, KV, endpoint and state: Loading (with elapsed time and the latest
`[strata]` status line, no timeout), Ready, Busy, Unloaded, Unreachable, Stopping
or Failed. Logs merges Python stdout (`[out]`), stderr (`[err]`) and the engine
log (`[engine]`, this run only); llama task/metrics parsing is not applied.

**Stop** asks Strata to unload the model, waits for the engine to exit, then ends
the service's process tree and verifies nothing is left. If the model is busy or
the service does not answer, Stop asks before force-stopping (active requests are
cancelled). **Restart** restarts the running session's profile. **Exit Now**
leaves the service running; the next launch reattaches only after confirming the
recorded process is still the same one (PID, start time and executable). A
session that cannot be verified is shown as unverified and is never stopped
automatically: Stop then only clears its marker after confirmation.
`llama-manager --stop` and **Stop & Exit** force-stop after a failed unload, and
report failure (exit code 1, or staying open) unless shutdown is confirmed.

### Strata metrics and task recovery

Dashboard polls stock `/metrics?requests=all` in the session-owned loop, even
when another tab is selected. It shows service activity, prompt progress,
reported rates/real live slots, queue and concurrency, and upstream **session
totals**. The current-session panel follows the llama Dashboard layout: totals
above slot-ordered activity, PP on the left and TG on the right, and completion
timings/drafts below. Serial service activity keeps the last completed task's
rates/tokens visible when idle, rather than replacing them with empty live data.
Reported parallel slots use their own rates; the latest service completion is
separate because upstream history does not identify its slot. Dashboard does
not list earlier sessions; those remain in Tasks. The summary TG is explicitly
labelled **history**, with measured coverage, because stock aggregate totals lack
engine-generated counts. Loaded Model distinguishes requested context/KV/spec from reported
values. A failed/auth-rejected/malformed snapshot is shown as unavailable;
last good data stays explicitly stale, not idle.

Tasks contains **recovered stored history**, not an invented copy of session
totals. **In** is evaluated input (processed minus cached); details show total
requested, processed and cached input. **Out** is delivered output, while
**TG** is the engine decode rate: engine-generated tokens can differ from
delivered tokens. Aggregate TG uses known engine-count/time pairs. **TT** is
prompt time + decode time; wall duration is separate. Unsupported measurements
show `n/a` and absent chart points, not zero. Cancelled/disconnected completions
retain their finish reason and count their measured work.

Strata retains at most 500 completions. Reattach imports retained records once
using session/epoch completion ordinals; identical requests remain distinct.
Unavailable earlier ranges are persisted as history gaps, disclosed in
Dashboard/Tasks and excluded from task/token charts. If counters/epochs are
inconsistent or a database write fails, recovery is visibly paused and retried,
without advancing its watermark. Prompt/response capture is not enabled.

The Tasks DB migration makes future llama and Strata tasks session-scoped:
reused displayed IDs no longer overwrite older sessions. It preserves existing
rows and creates a WAL-safe `tasks.db.pre-session-<timestamp>.bak` before
transactional migration. Pre-existing unscoped llama markers/archive rows remain
in the legacy namespace until a new managed launch; old origins are not guessed.
Startup awaits DB readiness before replay or polling.

System attributes model residency only to identity-verified native engine
descendants, not Python, and follows engine replacements. Missing counters or
changing identities leave residency unavailable. Host/adapter totals are not
increased by adding those per-process allocations again. Halo lifecycle is
live-accepted; phase-5 metrics/history/memory acceptance and proart CUDA/parallel
workload validation remain separate gates.

## Navigation

| Key | Action |
|---|---|
| `1`-`8` | Switch tabs |
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
| System | 4 | CPU/RAM/GPU memory, model residency, commit headroom and paging |
| Profiles | 5 | Profile management, preset editing, Strata profiles and Check/Configure |
| Versions | 6 | Local versions, releases, backend/fork selection, changelog, Strata inspection |
| Models | 7 | Local GGUFs, HF browse, download, delete |
| Options | 8 | Global app settings |

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
| Server stderr | `~/.local/state/llama-manager/logs/server.<timestamp>.err` | `%LOCALAPPDATA%\llama-manager\state\logs\server.<timestamp>.err` |

Raw stderr (crashes, asserts, backend/driver errors that bypass llama.cpp's own `--log-file` logger) is captured to the sibling `.err` file via direct OS-level redirection, so it survives even after "Exit Now" leaves the server running detached. It's merged into the Logs tab inline, prefixed with `[stderr]`.


## Themes

31 bundled themes including Catppuccin, Dracula, Gruvbox, Nord, Tokyo Night, and more. Each theme supports dark and light variants. Selectable from the Options tab.

## Tech Stack

TypeScript, terminal-kit (input only), undici, better-sqlite3, custom Control-based UI framework with double-buffered framebuffer rendering (no React, no Ink).

## License

Apache License 2.0
