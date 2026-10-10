import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { getErrFile, getLogsDir, getSessionFile, isStrataProfile } from "./config";
import type { ConfigData } from "./config";
import { buildStrataLaunchSpec, inspectStrata } from "./strata";
import type { StrataInspection } from "./strata";
import { findStrataInstallation, readStrataConfigSummary } from "./strataprofile";
import {
  buildStrataEnvironment, checkIdentity, checkPortAvailable, deriveStrataState, descendantsOf,
  describeUnloadFailure, fetchStrataStatus, fetchStrataMetrics, isRecordGone, readConfigApiKey, requestStrataUnload,
  resolvePollHost, resolveStrataApiKey, sameExecutable, strataBaseUrl, windowsProcessSnapshot,
} from "./strataservice";
import type { ApiKeySource, ProcessRecord, ProcessSnapshotProvider, StrataPollResult, StrataServiceState } from "./strataservice";
import { createFileTail, fileSizeOrZero } from "./logtail";
import type { FileTail } from "./logtail";
import { setStrataModelView } from "../ui/specialized/LoadedModelPanel";
import { setStrataMetrics } from "./metricstracker";
import type { StrataMetricsView } from "./stratametrics";
import { taskStore } from "./tasks";

/** Session marker v2 (STATE_DIR/session.json). Never contains secrets. */
export interface StrataSessionMarker {
  version: 2;
  runtime: "strata";
  sessionId: string;
  pid: number;
  pidCreatedAt: string;
  executable: string;
  engineExecutable: string | null;
  startedAt: number;
  installationId: string;
  installationRoot: string;
  profileName: string;
  configPath: string;
  host: string;
  port: number;
  pollHost: string;
  logFiles: { out: string; err: string; engine: string | null; engineStart: number };
  keySource: ApiKeySource;
  runtimeVersion?: string;
}

export function isStrataSessionMarker(value: unknown): value is StrataSessionMarker {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const logs = v.logFiles as Record<string, unknown> | undefined;
  return v.version === 2 && v.runtime === "strata" &&
    typeof v.sessionId === "string" && typeof v.pid === "number" && typeof v.pidCreatedAt === "string" &&
    typeof v.executable === "string" && typeof v.startedAt === "number" &&
    typeof v.installationId === "string" && typeof v.profileName === "string" &&
    typeof v.configPath === "string" && typeof v.host === "string" && typeof v.port === "number" &&
    typeof v.pollHost === "string" && !!logs && typeof logs.out === "string" && typeof logs.err === "string" &&
    (logs.engine === null || typeof logs.engine === "string") && typeof logs.engineStart === "number";
}

/** How the coordinator reports into the shared server log buffer/status (server.ts). */
export interface StrataHost {
  ingest(line: string): void;
  resetBuffer(): void;
  statusChanged(): void;
  setLogFiles(out: string | null, err: string | null): void;
  getConfig(): ConfigData | null;
}

export interface StrataSessionDeps {
  processes: ProcessSnapshotProvider;
  inspect(root: string): Promise<StrataInspection>;
  buildLaunch: typeof buildStrataLaunchSpec;
  checkPort(host: string, port: number): Promise<string | null>;
  terminateTree(pid: number): void;
  engineExitTimeoutMs: number;
  verifyTimeoutMs: number;
  unloadTimeoutMs: number;
}

function terminateTreeForce(pid: number): void {
  if (os.platform() === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

const DEFAULT_DEPS: StrataSessionDeps = {
  processes: windowsProcessSnapshot,
  inspect: (root) => inspectStrata(root),
  buildLaunch: buildStrataLaunchSpec,
  checkPort: checkPortAvailable,
  terminateTree: terminateTreeForce,
  engineExitTimeoutMs: 20_000,
  verifyTimeoutMs: 15_000,
  unloadTimeoutMs: 60_000,
};

let deps: StrataSessionDeps = { ...DEFAULT_DEPS };

/** Test seam. */
export function setStrataSessionDeps(partial: Partial<StrataSessionDeps>): void {
  deps = { ...deps, ...partial };
}

export function resetStrataSessionDeps(): void {
  deps = { ...DEFAULT_DEPS };
}

let host: StrataHost | null = null;

export function setStrataHost(h: StrataHost): void {
  host = h;
}

interface ConfigView {
  model: string;
  backend: string | null;
  context: string | null;
  kv: string | null;
  spec?: string | null;
}

interface ActiveSession {
  marker: StrataSessionMarker;
  child: ChildProcess | null;
  monitor: boolean;
  httpSeen: boolean;
  lastPoll: StrataPollResult | null;
  state: StrataServiceState;
  detail: string | null;
  lastStatusLine: string | null;
  stopping: boolean;
  tails: FileTail[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollIntervalMs: number;
  view: ConfigView;
  request: AbortController | null;
  metrics: StrataMetricsView;
  failures: number;
}

let active: ActiveSession | null = null;
let unverified: { marker: StrataSessionMarker; reason: string } | null = null;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearMarkerFile(): void {
  try { fs.removeSync(getSessionFile()); } catch { /* best-effort */ }
}

function fmtTokens(value: string | null): string | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}K` : String(n);
}

async function loadConfigView(marker: StrataSessionMarker): Promise<ConfigView> {
  const summary = await readStrataConfigSummary(marker.configPath);
  const setting = (key: string) => summary.settings.find((s) => s.key === key)?.value ?? null;
  return {
    model: summary.model ?? path.basename(marker.configPath, ".json"),
    backend: summary.backend,
    context: fmtTokens(setting("max-context")),
    kv: setting("kv"),
    spec: setting("spec"),
  };
}

function publishView(): void {
  if (unverified) {
    const m = unverified.marker;
    setStrataModelView({
      model: path.basename(m.configPath, ".json"), backend: null, context: null, kv: null,
      endpoint: strataBaseUrl(m.pollHost, m.port), bind: `${m.host}:${m.port}`, keySource: m.keySource,
      state: "unverified", since: null,
      detail: `${unverified.reason}; it will not be stopped automatically. Stop clears the marker.`,
    });
    return;
  }
  if (!active || !active.monitor) return;
  const s = active;
  const loading = s.state === "loading" || s.state === "starting";
  setStrataModelView({
    ...s.view,
    endpoint: strataBaseUrl(s.marker.pollHost, s.marker.port),
    bind: `${s.marker.host}:${s.marker.port}`,
    keySource: s.marker.keySource,
    state: s.state,
    since: loading ? s.marker.startedAt : null,
    detail: loading ? s.lastStatusLine : s.detail,
    reported: s.metrics.snapshot ? {
      context: s.metrics.snapshot.context, kv: s.metrics.snapshot.kv, spec: s.metrics.snapshot.spec,
    } : null,
    requestedSpec: s.view.spec ?? null,
    reportedStale: !!s.metrics.error,
  });
}

function setState(s: ActiveSession, state: StrataServiceState, detail: string | null): void {
  const changed = s.state !== state || s.detail !== detail;
  s.state = state;
  s.detail = detail;
  publishView();
  if (changed) host?.statusChanged();
}

function onOutLine(s: ActiveSession, line: string): void {
  host?.ingest(`[out] ${line}`);
  const trimmed = line.trim();
  if (/^ready: http/.test(trimmed)) s.httpSeen = true;
  if (/^(\[strata\]|ready:|loading the model)/.test(trimmed)) {
    s.lastStatusLine = trimmed;
    if (active === s && (s.state === "loading" || s.state === "starting")) publishView();
  }
}

function resolveKey(marker: StrataSessionMarker, configKey: string | null): string | null {
  const profile = host?.getConfig()?.server.profiles[marker.profileName];
  return resolveStrataApiKey(profile?.presets.server.apiKey, configKey).key;
}

function schedulePoll(s: ActiveSession, delay: number): void {
  if (s.pollTimer) clearTimeout(s.pollTimer);
  s.pollTimer = setTimeout(() => { void pollOnce(s); }, delay);
  s.pollTimer.unref?.();
}

async function pollOnce(s: ActiveSession): Promise<void> {
  s.pollTimer = null;
  if (active !== s || s.stopping) return;
  const exited = s.child ? s.child.exitCode !== null || s.child.signalCode !== null : !isPidAlive(s.marker.pid);
  if (exited) {
    handleUnexpectedExit(s, null);
    return;
  }
  const controller = new AbortController();
  s.request = controller;
  const key = resolveKey(s.marker, await readConfigApiKey(s.marker.configPath));
  if (active !== s || s.stopping || controller.signal.aborted) return;
  const baseUrl = strataBaseUrl(s.marker.pollHost, s.marker.port);
  const result = await fetchStrataStatus(baseUrl, key, 5000, controller.signal);
  if (active !== s || s.stopping || controller.signal.aborted) return;
  if (result.kind === "ok") {
    s.httpSeen = true;
    if (result.status.model && s.view.model !== result.status.model) s.view.model = result.status.model;
  }
  s.lastPoll = result;
  const next = deriveStrataState({ stopping: false, httpSeen: s.httpSeen, poll: result });
  setState(s, next.state, next.detail);
  let error: string | null = null;
  let historyError: string | null = null;
  if (result.kind === "ok") {
    try {
      const snapshot = await fetchStrataMetrics(baseUrl, key, controller.signal);
      if (active !== s || s.stopping || controller.signal.aborted) return;
      s.metrics.snapshot = snapshot;
      s.metrics.receivedAt = Date.now();
      try {
        s.metrics.missingRequests = taskStore.ingestStrata({
          runtime: "strata", sessionId: s.marker.sessionId, profile: s.marker.profileName,
          version: s.marker.runtimeVersion ?? (snapshot.engineVersion ? `Strata engine ${snapshot.engineVersion}` : `strata:${s.marker.installationId}`),
        }, snapshot);
      } catch (failure) {
        historyError = errorMessage(failure);
      }
    } catch (failure) {
      error = errorMessage(failure);
    }
  } else {
    error = result.kind === "unauthorized" ? "Strata rejected the API key" :
      result.kind === "http-error" ? `Strata status HTTP ${result.status}` : `Strata status ${result.error}`;
  }
  if (active !== s || s.stopping || controller.signal.aborted) return;
  if (error !== s.metrics.error || historyError !== s.metrics.historyError) {
    if (error || historyError) host?.ingest(`[server] Telemetry: ${error ?? historyError}`);
    else if (s.metrics.error || s.metrics.historyError) host?.ingest("[server] Strata telemetry recovered");
  }
  s.metrics.error = error;
  s.metrics.historyError = historyError;
  setStrataMetrics({ ...s.metrics });
  publishView();
  s.request = null;
  s.failures = error ? Math.min(s.failures + 1, 4) : 0;
  schedulePoll(s, Math.min(30_000, s.pollIntervalMs * 2 ** s.failures));
}

function stopMonitoring(s: ActiveSession): void {
  s.request?.abort();
  if (s.pollTimer) clearTimeout(s.pollTimer);
  s.pollTimer = null;
  for (const tail of s.tails) tail.stop(true);
  s.tails = [];
}

function handleUnexpectedExit(s: ActiveSession, code: number | null): void {
  if (active !== s || s.stopping) return;
  stopMonitoring(s);
  clearMarkerFile();
  active = null;
  const message = `Strata service exited${code !== null ? ` with code ${code}` : ""}`;
  s.metrics.error = message;
  setStrataMetrics({ ...s.metrics });
  host?.ingest(`[server] ${message}`);
  setStrataModelView({
    ...s.view,
    endpoint: strataBaseUrl(s.marker.pollHost, s.marker.port),
    bind: `${s.marker.host}:${s.marker.port}`,
    keySource: s.marker.keySource,
    state: "failed", since: null,
    detail: `${message}; see the [err]/[engine] lines on the Logs tab`,
  });
  host?.statusChanged();
}

function activate(marker: StrataSessionMarker, child: ChildProcess | null, monitor: boolean, pollIntervalMs: number): ActiveSession {
  const s: ActiveSession = {
    marker, child, monitor, httpSeen: false, lastPoll: null, state: "loading", detail: null,
    lastStatusLine: null, stopping: false, tails: [], pollTimer: null,
    pollIntervalMs: Math.max(250, pollIntervalMs),
    view: { model: path.basename(marker.configPath, ".json"), backend: null, context: null, kv: null },
    request: null, metrics: { snapshot: null, receivedAt: null, error: null, historyError: null,
      missingRequests: taskStore.getHistoryGapCount(marker.sessionId) }, failures: 0,
  };
  active = s;
  unverified = null;
  child?.on("exit", (code) => handleUnexpectedExit(s, code));
  if (!monitor) return s;
  host?.resetBuffer();
  taskStore.setSource({ runtime: "strata", sessionId: marker.sessionId });
  setStrataMetrics({ ...s.metrics });
  host?.setLogFiles(marker.logFiles.out, marker.logFiles.err);
  const { out, err, engine, engineStart } = marker.logFiles;
  s.tails.push(createFileTail(out, 0, (line) => onOutLine(s, line)));
  s.tails.push(createFileTail(err, 0, (line) => host?.ingest(`[err] ${line}`)));
  if (engine && !sameExecutable(engine, out) && !sameExecutable(engine, err)) {
    s.tails.push(createFileTail(engine, engineStart, (line) => host?.ingest(`[engine] ${line}`)));
  }
  publishView();
  void loadConfigView(marker).then((view) => {
    if (active !== s) return;
    s.view = { ...view, model: s.view.model !== path.basename(marker.configPath, ".json") ? s.view.model : view.model };
    publishView();
  });
  schedulePoll(s, 0);
  host?.statusChanged();
  return s;
}

export interface StrataStartOptions {
  detached: boolean;
  pollIntervalMs: number;
}

function profileEndpoint(profile: { presets: { server: Record<string, unknown> } }): { host: string; port: number } {
  const rawHost = profile.presets.server.host;
  const rawPort = profile.presets.server.port;
  const hostValue = typeof rawHost === "string" && rawHost.trim() ? rawHost.trim() : "0.0.0.0";
  const port = typeof rawPort === "number" ? rawPort : Number(rawPort ?? 1234);
  return { host: hostValue, port };
}

function readTail(file: string, lines = 5): string {
  try {
    return fs.readFileSync(file, "utf-8").split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join(" | ");
  } catch {
    return "";
  }
}

export async function startStrataSession(config: ConfigData, profileName: string, options: StrataStartOptions): Promise<number> {
  if (active || unverified) throw new Error("A Strata session is already tracked; stop it first");
  const profile = config.server.profiles[profileName];
  if (!isStrataProfile(profile)) throw new Error(`Profile "${profileName}" is not a Strata profile`);
  const installation = findStrataInstallation(config, profile.strata.installationId);
  if (!installation) throw new Error(`Strata installation for "${profileName}" is not registered; pick one on the Profiles tab`);
  const configPath = profile.strata.configPath;
  if (!configPath) throw new Error(`Profile "${profileName}" has no Strata config; run Configure, then select a config`);
  if (!(await fs.pathExists(configPath))) throw new Error(`Strata config is missing: ${configPath}`);
  const { host: bindHost, port } = profileEndpoint(profile);

  const inspection = await deps.inspect(installation.root);
  let spec;
  try {
    spec = deps.buildLaunch(inspection, configPath, bindHost, port);
  } catch (error) {
    const issues = [...inspection.issues,
      ...(inspection.configs.find((c) => c.path === path.resolve(configPath))?.issues ?? [])];
    throw new Error(`${errorMessage(error)}${issues.length ? `: ${issues.slice(0, 3).join("; ")}` : ""}`);
  }
  const configInfo = inspection.configs.find((c) => c.path === path.resolve(configPath));

  const portIssue = await deps.checkPort(bindHost, port);
  if (portIssue) throw new Error(portIssue);

  const profileKeyRaw = profile.presets.server.apiKey;
  const profileKey = typeof profileKeyRaw === "string" && profileKeyRaw.trim() ? profileKeyRaw.trim() : null;
  const keySource = resolveStrataApiKey(profileKey, await readConfigApiKey(configPath)).source;

  const ts = new Date().toISOString().replace(/:/g, "-");
  const out = path.join(getLogsDir(), `strata.${ts}.log`);
  const err = getErrFile(out);
  await fs.ensureDir(path.dirname(out));
  const engine = configInfo?.log ?? null;
  const engineStart = fileSizeOrZero(engine);

  const outFd = fs.openSync(out, "a");
  const errFd = fs.openSync(err, "a");
  let child: ChildProcess;
  try {
    child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...buildStrataEnvironment(process.env, profileKey), ...spec.environment },
      stdio: ["ignore", outFd, errFd],
      detached: options.detached,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  if (options.detached) child.unref();
  const pid = child.pid!;
  const startedAt = Date.now();
  // Track exit from spawn onward: a later listener would miss an exit during the async checks below.
  let exitCode: number | null | undefined;
  child.once("exit", (code) => { exitCode = code; });
  const exitedMessage = () => {
    const tail = readTail(err) || readTail(out);
    return `Strata exited during startup${exitCode !== null && exitCode !== undefined ? ` with code ${exitCode}` : ""}${tail ? `: ${tail}` : `; see ${err}`}`;
  };
  // While our handle has not reported exit, Windows cannot reuse this PID, so killing it is safe.
  const stopOwnChild = (): string => {
    if (exitCode !== undefined) return "it had already exited";
    deps.terminateTree(pid);
    return "it was stopped";
  };

  let record: ProcessRecord | undefined;
  try {
    record = (await deps.processes.snapshot()).find((r) => r.pid === pid);
  } catch (error) {
    throw new Error(`Cannot verify the started Strata process (${errorMessage(error)}); ${stopOwnChild()}`);
  }
  if (exitCode !== undefined || !record) throw new Error(exitedMessage());
  if (!record.createdAt) {
    throw new Error(`Cannot read the started Strata process creation time; ${stopOwnChild()}`);
  }

  const marker: StrataSessionMarker = {
    version: 2, runtime: "strata", sessionId: randomUUID(),
    pid, pidCreatedAt: record.createdAt, executable: record.executable ?? spec.executable,
    engineExecutable: configInfo?.executable || null, startedAt,
    installationId: installation.id, installationRoot: installation.root, profileName,
    configPath: path.resolve(configPath), host: bindHost, port, pollHost: resolvePollHost(bindHost),
    logFiles: { out, err, engine, engineStart }, keySource,
    runtimeVersion: `Strata ${inspection.sourceTag ?? inspection.sourceRevision ?? "source unknown"} / engine ${inspection.engineVersion ?? "unknown"}`,
  };
  try {
    await fs.outputJson(getSessionFile(), marker, { spaces: 2 });
  } catch (error) {
    throw new Error(`Could not write the session marker (${errorMessage(error)}); ${stopOwnChild()} because it could not be resumed later`);
  }
  if (exitCode !== undefined) {
    clearMarkerFile();
    throw new Error(exitedMessage());
  }
  activate(marker, child, true, options.pollIntervalMs);
  return pid;
}

export type ReattachResult =
  | { kind: "gone" }
  | { kind: "verified"; marker: StrataSessionMarker }
  | { kind: "unverified"; marker: StrataSessionMarker; reason: string };

/** Synchronous so app startup and `--stop` can adopt a session before anything else runs. */
export function reattachStrataSession(marker: StrataSessionMarker, options: { monitor: boolean; pollIntervalMs: number }): ReattachResult {
  if (!isPidAlive(marker.pid)) {
    clearMarkerFile();
    return { kind: "gone" };
  }
  let records: ProcessRecord[];
  try {
    records = deps.processes.snapshotSync();
  } catch (error) {
    unverified = { marker, reason: `identity check failed (${errorMessage(error)})` };
    publishView();
    return { kind: "unverified", marker, reason: unverified.reason };
  }
  const identity = checkIdentity(records, { pid: marker.pid, createdAt: marker.pidCreatedAt, executable: marker.executable });
  if (identity.kind === "gone") {
    clearMarkerFile();
    return { kind: "gone" };
  }
  if (identity.kind === "mismatch") {
    unverified = { marker, reason: identity.reason };
    publishView();
    host?.statusChanged();
    return { kind: "unverified", marker, reason: identity.reason };
  }
  const s = activate(marker, null, options.monitor, options.pollIntervalMs);
  // The service was already up when this process saw it; output before "ready" is history.
  s.httpSeen = fs.pathExistsSync(marker.logFiles.out) && /^ready: http/m.test(fs.readFileSync(marker.logFiles.out, "utf-8"));
  return { kind: "verified", marker };
}

export type StopMode = "graceful" | "force-on-failure" | "force";

export type StopResult =
  | { ok: true; forced: boolean; reason?: string }
  | { ok: false; reason: string; canForce: boolean };

function isEngine(record: ProcessRecord, marker: StrataSessionMarker): boolean {
  return sameExecutable(record.executable, marker.engineExecutable) || record.name.toLowerCase() === "strata.exe";
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/** Every stop failure that keeps the session must restore its displayed state and polling. */
function resumeAfterFailedStop(s: ActiveSession): void {
  s.stopping = false;
  if (active !== s) return;
  const exited = s.child ? s.child.exitCode !== null || s.child.signalCode !== null : !isPidAlive(s.marker.pid);
  if (exited) {
    handleUnexpectedExit(s, s.child?.exitCode ?? null);
    return;
  }
  const next = s.lastPoll
    ? deriveStrataState({ stopping: false, httpSeen: s.httpSeen, poll: s.lastPoll })
    : { state: "loading" as StrataServiceState, detail: null };
  setState(s, next.state, next.detail);
  if (s.monitor) schedulePoll(s, 0);
}

function finishStop(s: ActiveSession): void {
  stopMonitoring(s);
  clearMarkerFile();
  if (active === s) active = null;
  setStrataModelView(null);
  setStrataMetrics(null);
  host?.statusChanged();
}

export async function stopStrataSession(mode: StopMode): Promise<StopResult> {
  if (unverified) {
    return { ok: false, reason: `Session PID ${unverified.marker.pid} could not be verified (${unverified.reason})`, canForce: false };
  }
  const s = active;
  if (!s) return { ok: true, forced: false };
  const marker = s.marker;
  s.stopping = true;
  s.request?.abort();
  if (s.pollTimer) clearTimeout(s.pollTimer);
  setState(s, "stopping", null);

  let forcedReason: string | undefined;
  if (mode !== "force") {
    const key = resolveKey(marker, await readConfigApiKey(marker.configPath));
    const unload = await requestStrataUnload(strataBaseUrl(marker.pollHost, marker.port), key, deps.unloadTimeoutMs);
    if (unload.kind !== "unloaded") {
      const reason = describeUnloadFailure(unload);
      if (mode === "graceful") {
        resumeAfterFailedStop(s);
        return { ok: false, reason: `Cooperative unload failed: ${reason}`, canForce: true };
      }
      forcedReason = reason;
    } else {
      host?.ingest("[server] Strata model unloaded");
      const engineGone = await waitFor(async () => {
        const records = await deps.processes.snapshot().catch(() => null);
        return !!records && !descendantsOf(records, marker.pid).some((r) => isEngine(r, marker));
      }, deps.engineExitTimeoutMs);
      if (!engineGone) {
        const reason = `the engine did not exit within ${Math.round(deps.engineExitTimeoutMs / 1000)} s of unload`;
        if (mode === "graceful") {
          resumeAfterFailedStop(s);
          return { ok: false, reason: `Cooperative stop failed: ${reason}`, canForce: true };
        }
        forcedReason = reason;
      }
    }
  }

  let records: ProcessRecord[];
  try {
    records = await deps.processes.snapshot();
  } catch (error) {
    resumeAfterFailedStop(s);
    return { ok: false, reason: `Cannot verify the Strata process before stopping it (${errorMessage(error)})`, canForce: true };
  }
  const identity = checkIdentity(records, { pid: marker.pid, createdAt: marker.pidCreatedAt, executable: marker.executable });
  if (identity.kind !== "verified") {
    // The recorded supervisor is gone (its PID may already be reused): nothing of ours left to kill.
    finishStop(s);
    return { ok: true, forced: mode === "force" || !!forcedReason, reason: forcedReason };
  }
  const tree = [identity.record, ...descendantsOf(records, marker.pid)];
  deps.terminateTree(marker.pid);
  let remaining: ProcessRecord[] = tree;
  const gone = await waitFor(async () => {
    const now = await deps.processes.snapshot().catch(() => null);
    if (!now) return false;
    remaining = tree.filter((r) => !isRecordGone(now, r));
    return remaining.length === 0;
  }, deps.verifyTimeoutMs);
  if (!gone) {
    resumeAfterFailedStop(s);
    return {
      ok: false,
      reason: `Strata processes are still running: ${remaining.map((r) => `${r.name} (PID ${r.pid})`).join(", ")}`,
      canForce: true,
    };
  }
  host?.ingest("[server] Strata service stopped");
  finishStop(s);
  return { ok: true, forced: mode === "force" || !!forcedReason, reason: forcedReason };
}

/**
 * Synchronous identity-checked force stop for process exit (`killServerOnExit`),
 * where async unload/verification cannot complete. Returns true only when the
 * tree is confirmed gone; otherwise the marker is kept so `--stop` can retry.
 */
export function forceStopStrataSessionSync(): boolean {
  const s = active;
  if (!s) return false;
  s.stopping = true;
  stopMonitoring(s);
  const target = { pid: s.marker.pid, createdAt: s.marker.pidCreatedAt, executable: s.marker.executable };
  let records: ProcessRecord[];
  try {
    records = deps.processes.snapshotSync();
  } catch {
    return false;
  }
  const identity = checkIdentity(records, target);
  if (identity.kind === "verified") {
    const tree = [identity.record, ...descendantsOf(records, s.marker.pid)];
    deps.terminateTree(s.marker.pid);
    const deadline = Date.now() + Math.min(deps.verifyTimeoutMs, 10_000);
    let confirmed = false;
    for (;;) {
      try {
        const now = deps.processes.snapshotSync();
        confirmed = tree.every((r) => isRecordGone(now, r));
      } catch {
        confirmed = false;
      }
      if (confirmed || Date.now() >= deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!confirmed) return false;
  } else if (identity.kind === "mismatch") {
    // PID alive but not ours: leave the marker so the next launch reports it as unverified.
    return false;
  }
  clearMarkerFile();
  active = null;
  return identity.kind === "verified";
}

export function clearUnverifiedStrataSession(): boolean {
  if (!unverified) return false;
  unverified = null;
  clearMarkerFile();
  setStrataModelView(null);
  host?.statusChanged();
  return true;
}

export interface StrataSessionStatus {
  running: boolean;
  pid: number | null;
  uptime: number;
  profileName: string;
  installationId: string;
  state: StrataServiceState;
  detail: string | null;
}

export function getStrataSessionStatus(): StrataSessionStatus | null {
  if (unverified) {
    const m = unverified.marker;
    return {
      running: false, pid: m.pid, uptime: 0, profileName: m.profileName, installationId: m.installationId,
      state: "unverified", detail: unverified.reason,
    };
  }
  if (!active) return null;
  const m = active.marker;
  return {
    running: true, pid: m.pid, uptime: Date.now() - m.startedAt, profileName: m.profileName,
    installationId: m.installationId, state: active.state, detail: active.detail,
  };
}

export function hasStrataSession(): boolean {
  return !!active || !!unverified;
}

export function isStrataInstallationInUse(installationId: string): boolean {
  return active?.marker.installationId === installationId || unverified?.marker.installationId === installationId;
}

export function setStrataPollInterval(intervalMs: number): void {
  if (active) active.pollIntervalMs = Math.max(250, intervalMs);
}

export function getStrataProcessTarget(): {
  pid: number; createdAt: string; executable: string; engineExecutable: string;
} | null {
  if (!active?.marker.engineExecutable) return null;
  const m = active.marker;
  return { pid: m.pid, createdAt: m.pidCreatedAt, executable: m.executable, engineExecutable: m.engineExecutable! };
}

/** Test helper: forget in-memory state without touching processes or the marker. */
export function resetStrataSessionForTests(): void {
  if (active) stopMonitoring(active);
  active = null;
  unverified = null;
}
