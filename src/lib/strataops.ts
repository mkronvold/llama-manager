import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import { getStrataOpsDir } from "./config";
import type { StrataInstallation } from "./runtime";

export type StrataOpAction = "check" | "configure";
export type StrataOpState =
  | "starting" | "running" | "exited"
  | "completed" | "failed" | "abandoned" | "incomplete";

export interface StrataOpMarker {
  version: 1;
  opId: string;
  installationId: string;
  root: string;
  action: StrataOpAction;
  state: StrataOpState;
  wrapperPid: number | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  detail: string | null;
}

export const TERMINAL_STATES: ReadonlySet<StrataOpState> = new Set(["completed", "failed", "abandoned", "incomplete"]);
/** A wrapper that never reported its PID within this window is treated as never started. */
const START_GRACE_MS = 120_000;
const MAX_MARKERS_PER_INSTALLATION = 20;

export interface StrataOpsDeps {
  opsDir?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  launchWindow?: (scriptPath: string) => Promise<void>;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Command run by a hidden launcher PowerShell to open the wrapper in a new console window.
 * Node's `detached` spawn on Windows uses DETACHED_PROCESS (no console at all), so the
 * window must come from Start-Process, which always allocates a new console.
 */
export function buildStrataLaunchCommand(scriptPath: string): string {
  return "$ProgressPreference = 'SilentlyContinue'; " +
    "Start-Process -FilePath 'powershell.exe' -ArgumentList @(" +
    `'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${psQuote(`"${scriptPath}"`)})`;
}

/** Opens a new console window running the wrapper; it outlives the manager. */
function defaultLaunchWindow(scriptPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(buildStrataLaunchCommand(scriptPath), "utf16le").toString("base64");
    const child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`launcher exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
    });
  });
}

export function strataToolArgs(action: StrataOpAction): string[] {
  return action === "check"
    ? ["setup.py", "--check"]
    : ["setup.py", "--setup", "--no-start", "--no-browser"];
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildStrataWrapperScript(opts: {
  root: string;
  python: string;
  args: string[];
  pidFile: string;
  exitFile: string;
  title: string;
}): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$Host.UI.RawUI.WindowTitle = ${psQuote(opts.title)}`,
    `[System.IO.File]::WriteAllText(${psQuote(opts.pidFile)}, [string]$PID)`,
    `Set-Location -LiteralPath ${psQuote(opts.root)}`,
    `Write-Host ${psQuote(`llama-manager: running Strata ${opts.title}`)}`,
    "$code = -1",
    "try {",
    `  & ${psQuote(opts.python)} ${opts.args.map(psQuote).join(" ")}`,
    "  if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }",
    "} catch {",
    "  Write-Host $_",
    "}",
    `[System.IO.File]::WriteAllText(${psQuote(opts.exitFile)}, [string]$code)`,
    "Write-Host ''",
    "Write-Host \"Finished with exit code $code. llama-manager will refresh this installation.\"",
    "Read-Host 'Press Enter to close this window' | Out-Null",
    "",
  ].join("\r\n");
}

function files(opsDir: string, opId: string) {
  return {
    marker: path.join(opsDir, `${opId}.json`),
    script: path.join(opsDir, `${opId}.ps1`),
    pid: path.join(opsDir, `${opId}.pid`),
    exit: path.join(opsDir, `${opId}.exit`),
  };
}

async function writeMarker(opsDir: string, marker: StrataOpMarker): Promise<void> {
  const target = files(opsDir, marker.opId).marker;
  const tmp = `${target}.tmp`;
  await fs.writeJson(tmp, marker, { spaces: 2 });
  await fs.move(tmp, target, { overwrite: true });
}

async function readIntFile(file: string): Promise<number | null> {
  try {
    const text = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "").trim();
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function isMarker(value: unknown): value is StrataOpMarker {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.version === 1 && typeof m.opId === "string" && typeof m.installationId === "string" &&
    (m.action === "check" || m.action === "configure") && typeof m.state === "string" &&
    typeof m.startedAt === "string";
}

export async function listStrataOps(installationId?: string, deps: StrataOpsDeps = {}): Promise<StrataOpMarker[]> {
  const opsDir = deps.opsDir ?? getStrataOpsDir();
  let names: string[];
  try {
    names = await fs.readdir(opsDir);
  } catch {
    return [];
  }
  const markers: StrataOpMarker[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const value: unknown = await fs.readJson(path.join(opsDir, name));
      if (isMarker(value) && (!installationId || value.installationId === installationId)) markers.push(value);
    } catch {
      // ignore partially written or foreign files
    }
  }
  return markers.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Advances a non-terminal marker from wrapper sidecar files: PID reported -> running,
 * exit code reported -> exited, wrapper gone without exit code -> abandoned.
 */
export async function reconcileStrataOp(marker: StrataOpMarker, deps: StrataOpsDeps = {}): Promise<StrataOpMarker> {
  if (TERMINAL_STATES.has(marker.state) || marker.state === "exited") return marker;
  const opsDir = deps.opsDir ?? getStrataOpsDir();
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const f = files(opsDir, marker.opId);
  const next: StrataOpMarker = { ...marker };
  const pid = await readIntFile(f.pid);
  if (pid !== null) next.wrapperPid = pid;
  const exitCode = await readIntFile(f.exit);
  if (exitCode !== null) {
    next.state = "exited";
    next.exitCode = exitCode;
  } else if (next.wrapperPid !== null) {
    if (isPidAlive(next.wrapperPid)) next.state = "running";
    else {
      next.state = "abandoned";
      next.detail = "The tool window closed before the run finished";
      next.finishedAt = new Date(now()).toISOString();
    }
  } else if (now() - Date.parse(next.startedAt) > START_GRACE_MS) {
    next.state = "abandoned";
    next.detail = "The tool window never started";
    next.finishedAt = new Date(now()).toISOString();
  }
  if (next.state !== marker.state || next.wrapperPid !== marker.wrapperPid) await writeMarker(opsDir, next);
  if (TERMINAL_STATES.has(next.state)) await cleanupSidecars(opsDir, next.opId);
  return next;
}

async function cleanupSidecars(opsDir: string, opId: string): Promise<void> {
  const f = files(opsDir, opId);
  await Promise.all([f.script, f.pid, f.exit].map((file) => fs.remove(file).catch(() => undefined)));
}

/**
 * Turns an exited run into its final state. A non-zero exit is "failed". Configure
 * succeeds only when revalidation finds a usable config; exit 0 alone is not proof.
 */
export async function finalizeStrataOp(
  marker: StrataOpMarker,
  revalidate: () => Promise<{ ready: boolean; detail?: string }>,
  deps: StrataOpsDeps = {},
): Promise<StrataOpMarker> {
  if (marker.state !== "exited") return marker;
  const opsDir = deps.opsDir ?? getStrataOpsDir();
  const now = deps.now ?? Date.now;
  const next: StrataOpMarker = { ...marker, finishedAt: new Date(now()).toISOString() };
  if (marker.exitCode !== 0) {
    next.state = "failed";
    next.detail = `Exited with code ${marker.exitCode}`;
  } else if (marker.action === "configure") {
    let result: { ready: boolean; detail?: string };
    try {
      result = await revalidate();
    } catch (error) {
      result = { ready: false, detail: error instanceof Error ? error.message : String(error) };
    }
    next.state = result.ready ? "completed" : "incomplete";
    next.detail = result.ready ? null : (result.detail ?? "Setup finished but no usable model config was found");
  } else {
    next.state = "completed";
    next.detail = null;
  }
  await writeMarker(opsDir, next);
  await cleanupSidecars(opsDir, next.opId);
  return next;
}

export function isActiveStrataOp(marker: StrataOpMarker): boolean {
  return marker.state === "starting" || marker.state === "running" || marker.state === "exited";
}

export class StrataOpBlockedError extends Error {}

export async function startStrataOp(
  installation: StrataInstallation,
  python: string,
  action: StrataOpAction,
  options: { isServiceUsingInstallation?: (id: string) => boolean } & StrataOpsDeps = {},
): Promise<StrataOpMarker> {
  const opsDir = options.opsDir ?? getStrataOpsDir();
  const now = options.now ?? Date.now;
  const existing = await listStrataOps(installation.id, options);
  const active: StrataOpMarker[] = [];
  for (const marker of existing) {
    const current = await reconcileStrataOp(marker, options);
    if (isActiveStrataOp(current)) active.push(current);
  }
  if (action === "configure") {
    if (active.length) {
      throw new StrataOpBlockedError(`A Strata ${active[0]!.action} run is already open for this installation`);
    }
    if (options.isServiceUsingInstallation?.(installation.id)) {
      throw new StrataOpBlockedError("Stop the Strata service using this installation before running Configure");
    }
  } else if (active.some((m) => m.action === "configure")) {
    throw new StrataOpBlockedError("Configure is running for this installation; wait for it to finish");
  }

  await fs.ensureDir(opsDir);
  const opId = `${now()}-${randomUUID().slice(0, 8)}`;
  const f = files(opsDir, opId);
  const marker: StrataOpMarker = {
    version: 1, opId, installationId: installation.id, root: installation.root, action,
    state: "starting", wrapperPid: null, exitCode: null,
    startedAt: new Date(now()).toISOString(), finishedAt: null, detail: null,
  };
  await fs.writeFile(f.script, `\uFEFF${buildStrataWrapperScript({
    root: installation.root, python, args: strataToolArgs(action),
    pidFile: f.pid, exitFile: f.exit, title: action === "check" ? "Check" : "Configure",
  })}`, "utf8");
  await writeMarker(opsDir, marker);
  try {
    await (options.launchWindow ?? defaultLaunchWindow)(f.script);
  } catch (error) {
    const failed: StrataOpMarker = {
      ...marker, state: "failed", finishedAt: new Date(now()).toISOString(),
      detail: `Could not open tool window: ${error instanceof Error ? error.message : String(error)}`,
    };
    await writeMarker(opsDir, failed);
    await cleanupSidecars(opsDir, opId);
    return failed;
  }
  await pruneStrataOps(installation.id, options);
  return marker;
}

async function pruneStrataOps(installationId: string, deps: StrataOpsDeps): Promise<void> {
  const opsDir = deps.opsDir ?? getStrataOpsDir();
  const markers = await listStrataOps(installationId, deps);
  for (const old of markers.slice(MAX_MARKERS_PER_INSTALLATION)) {
    if (!TERMINAL_STATES.has(old.state)) continue;
    await fs.remove(files(opsDir, old.opId).marker).catch(() => undefined);
  }
}

export function describeStrataOp(marker: StrataOpMarker): string {
  const name = marker.action === "check" ? "Check" : "Configure";
  switch (marker.state) {
    case "starting": return `${name} opening…`;
    case "running": return `${name} running in its own window`;
    case "exited": return `${name} finished; refreshing…`;
    case "completed": return `${name} completed`;
    case "failed": return `${name} failed${marker.detail ? `: ${marker.detail}` : ""}`;
    case "abandoned": return `${name} abandoned${marker.detail ? `: ${marker.detail}` : ""}`;
    case "incomplete": return `${name} incomplete${marker.detail ? `: ${marker.detail}` : ""}`;
  }
}
