import { spawn, ChildProcess, spawnSync } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import os from "os";
import fs from "fs-extra";
import { ConfigData, PRESET_CATEGORIES, getVersionsDir, getLogFile, getErrFile, getLogsDir, getSessionFile, getActivePresets, getActiveFreeFormArgs } from "./config";
import { logParser } from "./logparser";
import { processLine as processMetricLine, reset as resetMetrics } from "./metricstracker";
import { processModelLine, resetModelInfo } from "../ui/specialized/LoadedModelPanel";
import { taskStore } from "./tasks";
import { detectForkFromFolder, resolveBinaryName, isForkCompatibleWithPreset, isFieldCompatibleWithFork, getFieldFlag, isNegateInverted, getFieldTransform } from "./forks";

// NB: Windows/POSIX binary-name resolution lives solely in forks.ts's
// `resolveBinaryName()` (used below), which this file previously duplicated via a
// dead, unused local `resolveServerBinary()` helper — removed to avoid future drift
// between the two.

let serverProcess: ChildProcess | null = null;
let serverStartTime: number | null = null;
let currentLogFile: string | null = null;
let currentErrFile: string | null = null;

// A server left running via "Exit Now" outlives the process that spawned it, so a
// later launch of llama-manager has no `ChildProcess` handle for it — only what was
// recorded in the session marker file. `detachedSessionPid`/`detachedSessionStartedAt`
// track that case; `serverProcess` remains the source of truth whenever this process
// is the one that actually spawned the server.
let detachedSessionPid: number | null = null;
let detachedSessionStartedAt: number | null = null;

// Mutex to serialize start/stop operations
let serverMutex: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  const prev = serverMutex;
  serverMutex = prev.then(() => lock);
  return prev.then(() => fn()).finally(() => release());
}

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(10);

const statusEmitter = new EventEmitter();
statusEmitter.setMaxListeners(10);

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface SessionFileInfo {
  pid: number;
  startedAt: number;
  activeVersion: string | null;
  logFile: string | null;
  errFile?: string | null;
}

function writeSessionFile(info: SessionFileInfo): void {
  try {
    fs.ensureDirSync(path.dirname(getSessionFile()));
    fs.writeJsonSync(getSessionFile(), info, { spaces: 2 });
  } catch {
    // best-effort; a missing session file just means a future launch won't
    // detect a detached server left running from this one
  }
}

function clearSessionFile(): void {
  try {
    fs.removeSync(getSessionFile());
  } catch {
    // best-effort
  }
}

function readSessionFile(): SessionFileInfo | null {
  try {
    if (!fs.pathExistsSync(getSessionFile())) return null;
    const data = fs.readJsonSync(getSessionFile());
    if (data && typeof data.pid === "number") return data as SessionFileInfo;
    return null;
  } catch {
    return null;
  }
}

/**
 * Called once at app startup. Detects a server left running detached by a
 * previous "Exit Now" (or a crash) via the session marker file, so this
 * process's `getStatus()`/Dashboard can reflect it as running even though
 * this process never spawned it. Stale marker files (dead PID) are cleared.
 */
export function detectExistingSession(): SessionFileInfo | null {
  const info = readSessionFile();
  if (!info) return null;
  if (!isPidAlive(info.pid)) {
    clearSessionFile();
    return null;
  }
  detachedSessionPid = info.pid;
  detachedSessionStartedAt = info.startedAt;
  if (info.logFile) {
    currentLogFile = info.logFile;
    // Backfill the in-memory log buffer, task metrics, and loaded-model info
    // from the on-disk log (this process never spawned the server, so it
    // never saw any of its stdout live), then keep tailing for new lines so
    // the Dashboard/Logs/System tabs stay in sync with the still-running
    // detached server.
    tailDetachedLogFile(info.logFile);
    taskStore.setLogFile(info.logFile);
  }
  if (info.errFile) {
    currentErrFile = info.errFile;
    // Same idea for stderr: it's captured to its own file at the OS level
    // (see getErrFile()) independent of whether any llama-manager process is
    // alive, so backfill/tail it too and merge it into the same log view.
    tailErrFile(info.errFile);
  }
  return info;
}

const MAX_LOG_LINES = 2000;
export const serverLogLines: string[] = [];
let maxLogLines = MAX_LOG_LINES;
export function setMaxLogLines(n: number): void {
  maxLogLines = Math.max(1, n);
}

/**
 * Appends one already-split log line to the in-memory buffer and runs it
 * through the same parsers a freshly-spawned server's live stdout/stderr
 * relay uses (task log parser, metrics tracker, loaded-model info). Shared
 * by that live relay and by `tailDetachedLogFile()` below (reattached
 * sessions have no piped stdout to relay from, only the on-disk log file).
 */
function ingestLogLine(line: string): void {
  if (line.length === 0) return;
  serverLogLines.push(line);
  if (serverLogLines.length > maxLogLines) {
    serverLogLines.splice(0, serverLogLines.length - maxLogLines);
  }
  logEmitter.emit("log", line);
  logParser.processLine(line);
  processMetricLine(line);
  processModelLine(line);
}

let detachedTailStop: (() => void) | null = null;

/**
 * Backfills the in-memory log buffer/metrics/model info from an existing log
 * file on disk, then keeps polling for appended lines. Used for a session
 * this process reattached to (via the session marker file) rather than
 * spawned itself, so the Dashboard/Logs/System tabs reflect its state
 * instead of appearing as if nothing is running — mirrors
 * `LogParser.startFileTailer()`'s polling approach for the task-history
 * parser, but feeds the raw line buffer/metrics/model-info paths instead.
 */
function tailDetachedLogFile(filePath: string): void {
  if (detachedTailStop) {
    detachedTailStop();
    detachedTailStop = null;
  }
  resetMetrics();
  resetModelInfo();
  serverLogLines.length = 0;

  let position = 0;

  // Read whatever is already on disk synchronously so the Dashboard/Logs
  // tabs reflect the already-running server immediately on this launch,
  // rather than only after the first async poll interval fires.
  try {
    if (fs.pathExistsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.trim()) ingestLogLine(line);
      }
      position = Buffer.byteLength(content, "utf-8");
    }
  } catch {
    // best-effort; fall through to polling, which will retry
  }

  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size < position) position = 0; // file rotated/truncated
      if (stat.size === position) return;

      const fd = await fs.open(filePath, "r");
      try {
        const buf = Buffer.alloc(stat.size - position);
        await fs.read(fd, buf, 0, buf.length, position);
        position += buf.length;

        const text = buf.toString("utf-8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) ingestLogLine(line);
        }
      } finally {
        await fs.close(fd);
      }
    } catch {
      // Log file may not exist yet, be temporarily locked, or the server
      // may have exited between polls — best-effort, try again next tick.
    }
  };

  const interval = setInterval(poll, 1000);
  detachedTailStop = () => {
    stopped = true;
    clearInterval(interval);
  };
}

function stopDetachedLogTail(): void {
  if (detachedTailStop) {
    detachedTailStop();
    detachedTailStop = null;
  }
}

let errTailStop: (() => void) | null = null;

/**
 * Backfills and tails the sibling `.err` file (see `getErrFile()`) that
 * captures the server's raw stderr via direct file-descriptor redirection.
 * Unlike `tailDetachedLogFile()`, this does not reset metrics/model-info or
 * clear the log buffer — it only appends prefixed lines alongside whatever
 * the main log tailer/relay already produced, for both a freshly-spawned
 * session (no live stderr pipe to relay from anymore) and a reattached one.
 */
function tailErrFile(filePath: string): void {
  if (errTailStop) {
    errTailStop();
    errTailStop = null;
  }

  let position = 0;
  const emit = (line: string) => {
    if (line.trim()) ingestLogLine(`[stderr] ${line}`);
  };

  try {
    if (fs.pathExistsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) emit(line);
      position = Buffer.byteLength(content, "utf-8");
    }
  } catch {
    // best-effort; fall through to polling, which will retry
  }

  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size < position) position = 0; // file rotated/truncated
      if (stat.size === position) return;

      const fd = await fs.open(filePath, "r");
      try {
        const buf = Buffer.alloc(stat.size - position);
        await fs.read(fd, buf, 0, buf.length, position);
        position += buf.length;
        for (const line of buf.toString("utf-8").split("\n")) emit(line);
      } finally {
        await fs.close(fd);
      }
    } catch {
      // Err file may not exist yet or be temporarily locked — best-effort,
      // try again next tick.
    }
  };

  const interval = setInterval(poll, 1000);
  errTailStop = () => {
    stopped = true;
    clearInterval(interval);
  };
}

function stopErrTail(): void {
  if (errTailStop) {
    errTailStop();
    errTailStop = null;
  }
}

/** Clears the in-memory log buffer (does not touch the on-disk log file). */
export function clearServerLog(): void {
  serverLogLines.length = 0;
  logEmitter.emit("log", "");
}

export function onServerLog(listener: (line: string) => void): () => void {
  logEmitter.on("log", listener);
  return () => { logEmitter.off("log", listener); };
}

export function onServerStatusChange(listener: () => void): () => void {
  statusEmitter.on("change", listener);
  return () => { statusEmitter.off("change", listener); };
}

/**
 * Returns the path to the log file currently (or most recently) written by
 * the server, so the UI can offer to copy it to the clipboard. Falls back to
 * scanning the logs directory for the newest auto-named file if the server
 * hasn't been started yet in this process (e.g. after a restart).
 */
export function getCurrentLogFile(config?: ConfigData | null): string | null {
  if (currentLogFile) return currentLogFile;
  if (config?.server.logFile) return config.server.logFile;
  const logsDir = getLogsDir();
  if (!fs.pathExistsSync(logsDir)) return null;
  const files = fs.readdirSync(logsDir)
    .filter((f: string) => /^server\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return path.join(logsDir, files[files.length - 1]);
}

/**
 * Returns the path to the sibling `.err` file (raw stderr, see
 * `getErrFile()`) for the current/most recent log file, if known.
 */
export function getCurrentErrFile(config?: ConfigData | null): string | null {
  if (currentErrFile) return currentErrFile;
  const logFile = getCurrentLogFile(config);
  return logFile ? getErrFile(logFile) : null;
}

export function listDevices(config: ConfigData): string {
  const versionsDir = getVersionsDir(config);
  const activeVersion = config.activeVersion;
  if (!activeVersion) return "No active version selected";
  const fork = detectForkFromFolder(activeVersion);
  if (!fork.hasListDevices) {
    return `${fork.label} does not support --list-devices`;
  }

  const binaryName = resolveBinaryName(fork);
  const binary = path.join(versionsDir, activeVersion, binaryName);
  if (!fs.pathExistsSync(binary)) return `Binary not found: ${binary}`;
  try {
    const result = spawnSync(binary, ["--list-devices"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const out = (result.stdout || "").trim();
    const err = (result.stderr || "").trim();
    const combined = [out, err].filter(Boolean).join("\n");
    return combined || "No output from --list-devices";
  } catch (err: any) {
    return err.message || "Failed to list devices";
  }
}

interface ServerStatus {
  running: boolean;
  pid: number | null;
  uptime: number;
}


export function startServer(config: ConfigData): Promise<number> {
  return withLock(async () => {
    resetMetrics();
    return new Promise(async (resolve, reject) => {
      if (serverProcess?.pid) {
        reject(new Error("Server already running"));
        return;
      }
      if (detachedSessionPid && isPidAlive(detachedSessionPid)) {
        reject(new Error("Server already running (detached from a previous session)"));
        return;
      }

      const versionsDir = getVersionsDir(config);
      const activeVersion = config.activeVersion;
      if (!activeVersion) {
        reject(new Error("No active version selected"));
        return;
      }

      const fork = detectForkFromFolder(activeVersion);
      const binaryName = resolveBinaryName(fork);
      const binary = path.join(versionsDir, activeVersion, binaryName);
      if (!(await fs.pathExists(binary))) {
        reject(new Error(`Binary not found: ${binary}`));
        return;
      }

      const logFile = getLogFile(config);
      currentLogFile = logFile;
      await fs.ensureDir(path.dirname(logFile));
      stopDetachedLogTail();
      stopErrTail();
      taskStore.setLogFile(logFile);
      const logStream = await fs.createWriteStream(logFile, { flags: "a" });

      // Raw stderr (crashes, GGML asserts, backend/driver errors) is often
      // written directly with fprintf and never passed through llama.cpp's
      // own logger, so it would not appear in `--log-file` at all. Rather
      // than piping it through this process (which stops working the moment
      // this process exits, since "Exit Now" leaves the server running
      // detached), redirect the child's stderr straight to a file at the OS
      // level: the descriptor is inherited by the child at spawn time, so it
      // keeps writing to disk regardless of whether llama-manager is still
      // running. See getErrFile()/tailErrFile().
      const errFile = getErrFile(logFile);
      currentErrFile = errFile;
      await fs.ensureDir(path.dirname(errFile));
      const errFd = fs.openSync(errFile, "a");

      const args = buildArgs(config, logFile);
      serverStartTime = Date.now();
      // detached: true (+ unref below) lets the server outlive this process
      // — "Exit Now" is meant to leave it running headless, but on Windows an
      // attached child stays tied to this process's console/Job Object and
      // gets torn down by the OS when this process exits, even without any
      // explicit kill. Piping stdout below is unaffected by this: it's only
      // used for live in-app log tailing while both processes are alive —
      // the binary already writes its own `--log-file` independently, so
      // on-disk logging continues even after this process exits.
      // Configurable via Options > Server > Start Server Detached (defaults
      // to true); users who'd rather the server always die with
      // llama-manager can turn it off.
      const startDetached = config.server.startDetached !== false;
      serverProcess = spawn(binary, args, {
        stdio: ["ignore", "pipe", errFd],
        detached: startDetached,
        windowsHide: true,
      });
      fs.closeSync(errFd); // child already has its own inherited handle
      if (startDetached) serverProcess.unref();
      detachedSessionPid = null;
      detachedSessionStartedAt = null;
      writeSessionFile({
        pid: serverProcess.pid!,
        startedAt: serverStartTime,
        activeVersion: config.activeVersion ?? null,
        logFile,
        errFile,
      });

      serverProcess.stdout?.pipe(logStream);
      // stderr is no longer a Node stream (redirected to errFd above), so
      // tail the resulting file the same way a reattached session's stderr
      // is tailed — this also means live and reattached sessions share one
      // code path for stderr instead of two.
      tailErrFile(errFile);

      const relay = (stream: NodeJS.ReadableStream | null) => {
        let buf = "";
        stream?.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split("\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            ingestLogLine(part);
          }
        });
      };
      relay(serverProcess.stdout);

      statusEmitter.emit("change");
      serverProcess.on("error", (err) => reject(err));
      serverProcess.on("exit", (code, signal) => {
        const wasRunning = serverProcess !== null;
        serverProcess = null;
        serverStartTime = null;
        clearSessionFile();
        if (wasRunning) {
          resetMetrics();
          resetModelInfo();
          stopErrTail();
        }
        if (wasRunning && code !== 0 && code !== null) {
          serverLogLines.push(`[server] Process exited with code ${code}`);
          logEmitter.emit("log", `[server] Process exited with code ${code}`);
        }
        if (wasRunning && signal && signal !== "SIGTERM" && signal !== "SIGKILL") {
          serverLogLines.push(`[server] Process terminated by signal ${signal}`);
          logEmitter.emit("log", `[server] Process terminated by signal ${signal}`);
        }
        if (wasRunning) {
          statusEmitter.emit("change");
        }
      });

      resolve(serverProcess.pid!);
    });
  });
}

/**
 * Terminate a process (and its child tree) in a platform-appropriate way.
 *
 * Node's `ChildProcess.kill(signal)` does not deliver POSIX signals on Windows — any
 * signal string there triggers an immediate hard `TerminateProcess`, giving the target
 * binary no chance to flush the KV cache / close sockets gracefully. Use `taskkill`
 * instead: without `/F` it requests graceful termination (and, with `/T`, of the whole
 * process tree); with `/F` it force-kills, mirroring the existing SIGTERM-then-SIGKILL
 * escalation used on POSIX platforms.
 */
function terminateProcessTree(pid: number, force: boolean): void {
  if (os.platform() === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // process already gone
  }
}

export function stopServer(): Promise<void> {
  return withLock(() => new Promise((resolve) => {
    const pid = serverProcess?.pid ?? detachedSessionPid;
    if (!pid) {
      resolve();
      return;
    }

    const finish = () => {
      serverProcess = null;
      serverStartTime = null;
      detachedSessionPid = null;
      detachedSessionStartedAt = null;
      clearSessionFile();
      stopDetachedLogTail();
      stopErrTail();
      resetMetrics();
      resetModelInfo();
      resolve();
    };

    if (serverProcess?.pid === pid) {
      // We spawned it ourselves in this process — a real ChildProcess "exit"
      // event tells us definitively (and promptly) when it's gone.
      serverProcess.on("exit", finish);
    } else {
      // Reattached to a detached server from a previous process (or the
      // `--stop` CLI path) — there's no ChildProcess handle to listen on,
      // so poll for the PID to disappear instead.
      const poll = setInterval(() => {
        if (!isPidAlive(pid)) {
          clearInterval(poll);
          finish();
        }
      }, 300);
    }

    terminateProcessTree(pid, false);

    setTimeout(() => {
      if (isPidAlive(pid)) {
        terminateProcessTree(pid, true);
      }
    }, 5000);
  }));
}

export function getStatus(): ServerStatus {
  if (serverProcess?.pid) {
    const alive = isPidAlive(serverProcess.pid);
    return {
      running: alive,
      pid: serverProcess.pid,
      uptime: alive && serverStartTime ? Date.now() - serverStartTime : 0,
    };
  }

  // No ChildProcess handle in this process — check for a server left running
  // detached by a previous "Exit Now" (detected via detectExistingSession()
  // at startup).
  if (detachedSessionPid) {
    if (isPidAlive(detachedSessionPid)) {
      return {
        running: true,
        pid: detachedSessionPid,
        uptime: detachedSessionStartedAt ? Date.now() - detachedSessionStartedAt : 0,
      };
    }
    detachedSessionPid = null;
    detachedSessionStartedAt = null;
    clearSessionFile();
  }

  return { running: false, pid: null, uptime: 0 };
}

export function buildArgs(config: ConfigData, logFile: string): string[] {
  const args: string[] = [];
  const p = getActivePresets(config);

  const forkId = config.activeVersion ? detectForkFromFolder(config.activeVersion).id : "llama.cpp";

  // Non-schema args
  if (config.hfToken) args.push("--hf-token", config.hfToken);
  args.push("--log-file", logFile);
  args.push("--log-verbosity", "4");

  // Iterate schema to build args
  for (const cat of PRESET_CATEGORIES) {
    if (!isForkCompatibleWithPreset(forkId, cat.presetKey)) continue;
    const presetData = p[cat.presetKey];
    for (const field of cat.fields) {
      if (!isFieldCompatibleWithFork(forkId, field.key, cat.presetKey)) continue;
      const value = presetData[field.key];

      // Skip null/undefined/empty
      if (value === null || value === undefined) continue;
      if (typeof value === "string" && value.length === 0) continue;

      // Skip sentinel values
      if (field.skipValue !== undefined && value === field.skipValue) continue;

      // Resolve fork-specific flag
      const flag = getFieldFlag(forkId, field.key, cat.presetKey, field.flag);
      if (!flag) continue;

      // Apply value transform if fork defines one
      let processedValue: unknown = value;
      const transform = getFieldTransform(forkId, field.key, cat.presetKey);
      if (transform) {
        processedValue = transform(value);
      }

      const negateInverted = isNegateInverted(forkId, field.key, cat.presetKey);
      const effectiveNegate = field.negate ? !negateInverted : negateInverted;

      if (typeof processedValue === "boolean") {
        if (effectiveNegate) {
          // default=true: push --no-X when false
          if (!processedValue) args.push(`--no-${flag.substring(2)}`);
        } else {
          // default=false: push --X when true
          if (processedValue) args.push(flag);
        }
      } else {
        args.push(flag, String(processedValue));
      }
    }
  }

  // Free-form args
  for (const arg of getActiveFreeFormArgs(config)) {
    if (arg.trim()) {
      args.push(...arg.trim().split(/\s+/));
    }
  }

  return args;
}
