import { execFile, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fs from "fs-extra";
import { parseStrataMetrics, type StrataMetrics } from "./stratametrics";

const execFileAsync = promisify(execFile);

export interface ProcessRecord {
  pid: number;
  ppid: number;
  /** ISO-8601 UTC creation time, or null when Windows does not report it. */
  createdAt: string | null;
  executable: string | null;
  name: string;
}

export interface ProcessSnapshotProvider {
  snapshot(): Promise<ProcessRecord[]>;
  snapshotSync(): ProcessRecord[];
}

const PS_SNAPSHOT = [
  "$ErrorActionPreference='Stop'",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name | ForEach-Object {",
  "  $c = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
  "  '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId,$_.ParentProcessId,$c,$_.Name,$_.ExecutablePath",
  "}",
].join("\n");

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(PS_SNAPSHOT)];

/** Parses `pid|ppid|createdAt|name|executable` lines. Executable paths cannot contain `|` on Windows. */
export function parseProcessSnapshot(text: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.split("|");
    if (parts.length < 5) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    const executable = parts.slice(4).join("|").trim();
    records.push({
      pid, ppid,
      createdAt: parts[2]!.trim() || null,
      name: parts[3]!.trim(),
      executable: executable || null,
    });
  }
  return records;
}

export const windowsProcessSnapshot: ProcessSnapshotProvider = {
  async snapshot() {
    if (os.platform() !== "win32") throw new Error("Process identity checks are implemented for Windows only");
    const { stdout } = await execFileAsync("powershell.exe", PS_ARGS, {
      windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    return parseProcessSnapshot(stdout);
  },
  snapshotSync() {
    if (os.platform() !== "win32") throw new Error("Process identity checks are implemented for Windows only");
    const result = spawnSync("powershell.exe", PS_ARGS, {
      windowsHide: true, timeout: 20_000, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || "process snapshot failed").trim());
    return parseProcessSnapshot(result.stdout);
  },
};

export function sameExecutable(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Descendants of `rootPid`. A process whose recorded parent was created after
 * it cannot be its child (the parent PID was reused), so it is excluded.
 */
export function descendantsOf(records: ProcessRecord[], rootPid: number): ProcessRecord[] {
  const byPid = new Map(records.map((r) => [r.pid, r]));
  const result: ProcessRecord[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parentPid = queue.shift()!;
    const parent = byPid.get(parentPid);
    for (const r of records) {
      if (r.ppid !== parentPid || seen.has(r.pid)) continue;
      if (parent?.createdAt && r.createdAt && Date.parse(r.createdAt) < Date.parse(parent.createdAt)) continue;
      seen.add(r.pid);
      result.push(r);
      queue.push(r.pid);
    }
  }
  return result;
}

export interface ExpectedIdentity {
  pid: number;
  createdAt: string | null;
  executable: string;
}

export type IdentityResult =
  | { kind: "verified"; record: ProcessRecord }
  | { kind: "gone" }
  | { kind: "mismatch"; reason: string };

/** True when both timestamps name the same instant (tolerates sub-ms formatting). */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < 1;
}

export function checkIdentity(records: ProcessRecord[], expected: ExpectedIdentity): IdentityResult {
  const record = records.find((r) => r.pid === expected.pid);
  if (!record) return { kind: "gone" };
  if (!expected.createdAt || !record.createdAt) {
    return { kind: "mismatch", reason: "process creation time is unavailable" };
  }
  if (!sameInstant(record.createdAt, expected.createdAt)) {
    return { kind: "mismatch", reason: `PID ${expected.pid} now belongs to a different process (${record.name || "unknown"})` };
  }
  if (!sameExecutable(record.executable, expected.executable)) {
    return { kind: "mismatch", reason: `PID ${expected.pid} runs ${record.executable ?? record.name}, not ${expected.executable}` };
  }
  return { kind: "verified", record };
}

/** True when a recorded process (pid + creation time) no longer exists. */
export function isRecordGone(records: ProcessRecord[], target: ProcessRecord): boolean {
  const current = records.find((r) => r.pid === target.pid);
  if (!current) return true;
  if (target.createdAt && current.createdAt) return !sameInstant(target.createdAt, current.createdAt);
  return false;
}

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]", "*"]);

/**
 * Host the manager polls for a service bound to `bindHost`. Wildcard binds
 * are reached through loopback (as upstream prints its own `ready:` URL);
 * NIC-specific binds are polled on that address; IPv6 literals get brackets.
 */
export function resolvePollHost(bindHost: string): string {
  const h = bindHost.trim();
  if (WILDCARD_HOSTS.has(h)) return "127.0.0.1";
  const bare = h.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

export function strataBaseUrl(pollHost: string, port: number): string {
  return `http://${pollHost}:${port}`;
}

export type ApiKeySource = "profile" | "config" | "none";

export function resolveStrataApiKey(profileKey: unknown, configKey: string | null): { key: string | null; source: ApiKeySource } {
  if (typeof profileKey === "string" && profileKey.trim()) return { key: profileKey.trim(), source: "profile" };
  if (configKey && configKey.trim()) return { key: configKey.trim(), source: "config" };
  return { key: null, source: "none" };
}

/** Reads the generated config's own `api_key`, if any. Never throws. */
export async function readConfigApiKey(configPath: string): Promise<string | null> {
  try {
    const raw: unknown = await fs.readJson(configPath);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const key = (raw as Record<string, unknown>).api_key;
      return typeof key === "string" && key.trim() ? key : null;
    }
  } catch {
    // unreadable config: no key known
  }
  return null;
}

/**
 * Child environment for the Strata service. Any inherited STRATA_API_KEY is
 * removed (upstream would let it override the config's key, and an empty one
 * is a startup error); the profile key, when set, is passed only through this
 * variable so it never appears on a process command line.
 */
export function buildStrataEnvironment(base: NodeJS.ProcessEnv, profileKey: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.toUpperCase() === "STRATA_API_KEY") continue;
    env[k] = v;
  }
  // stdout/stderr are disk files, not a console: keep upstream's non-ASCII output encodable.
  env.PYTHONIOENCODING = "utf-8";
  if (profileKey) env.STRATA_API_KEY = profileKey;
  return env;
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function tryListen(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    server.listen({ host: WILDCARD_HOSTS.has(host.trim()) ? undefined : host.replace(/^\[|\]$/g, ""), port, exclusive: true }, () => {
      server.close(() => resolve(null));
    });
  });
}

/** Returns a reason when the port is already taken, otherwise null. */
export async function checkPortAvailable(bindHost: string, port: number): Promise<string | null> {
  const pollHost = resolvePollHost(bindHost);
  if (await tryConnect(pollHost, port, 1000)) return `Port ${port} is already in use (something answers on ${pollHost}:${port})`;
  const listenError = await tryListen(bindHost.trim(), port);
  if (listenError) return `Port ${port} on ${bindHost || "all interfaces"} is not available (${listenError})`;
  return null;
}

export interface StrataLiveStatus {
  loaded: boolean;
  inFlight: number;
  model: string | null;
  context: number | null;
  engine: string | null;
  upstreamStarted: number | null;
}

export type StrataPollResult =
  | { kind: "ok"; status: StrataLiveStatus }
  | { kind: "unauthorized" }
  | { kind: "http-error"; status: number }
  | { kind: "unreachable"; error: string };

function authHeaders(key: string | null): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.name === "TimeoutError" ? "timed out" : error.message;
  }
  return String(error);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseStrataStatus(body: unknown): StrataLiveStatus {
  const o = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const activity = o.activity && typeof o.activity === "object" ? o.activity as Record<string, unknown> : {};
  const context = o.context && typeof o.context === "object" ? o.context as Record<string, unknown> : {};
  return {
    loaded: o.loaded === true,
    inFlight: num(activity.in_flight) ?? 0,
    model: typeof o.model === "string" ? o.model : null,
    context: num(context.native) ?? num(o.cache_max_tokens),
    engine: typeof o.engine === "string" ? o.engine : null,
    upstreamStarted: num(o.started),
  };
}

export async function fetchStrataStatus(baseUrl: string, key: string | null, timeoutMs = 5000, signal?: AbortSignal): Promise<StrataPollResult> {
  try {
    const res = await fetch(`${baseUrl}/v1/status`, {
      headers: authHeaders(key), redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
    if (res.status !== 200) return { kind: "http-error", status: res.status };
    return { kind: "ok", status: parseStrataStatus(await res.json()) };
  } catch (error) {
    return { kind: "unreachable", error: errorText(error) };
  }

}

export async function fetchStrataMetrics(baseUrl: string, key: string | null, signal: AbortSignal): Promise<StrataMetrics> {
  const res = await fetch(`${baseUrl}/metrics?requests=all`, {
    headers: authHeaders(key), redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Strata metrics rejected the API key");
  if (res.status !== 200) throw new Error(`Strata metrics failed (HTTP ${res.status})`);
  return parseStrataMetrics(await res.json());
}

export type StrataUnloadResult =
  | { kind: "unloaded" }
  | { kind: "busy" }
  | { kind: "unauthorized" }
  | { kind: "error"; status: number; message: string }
  | { kind: "unreachable"; error: string };

export async function requestStrataUnload(baseUrl: string, key: string | null, timeoutMs = 60_000): Promise<StrataUnloadResult> {
  try {
    const res = await fetch(`${baseUrl}/v1/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(key) },
      body: "{}",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 200) return { kind: "unloaded" };
    if (res.status === 409) return { kind: "busy" };
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
    let message = "";
    try {
      const body = await res.json() as { error?: { message?: string } };
      message = body?.error?.message ?? "";
    } catch {
      // non-JSON body
    }
    return { kind: "error", status: res.status, message };
  } catch (error) {
    return { kind: "unreachable", error: errorText(error) };
  }
}

export function describeUnloadFailure(result: Exclude<StrataUnloadResult, { kind: "unloaded" }>): string {
  switch (result.kind) {
    case "busy": return "the model is busy with an active or queued request";
    case "unauthorized": return "the service rejected the API key";
    case "error": return `unload failed (HTTP ${result.status}${result.message ? `: ${result.message}` : ""})`;
    case "unreachable": return `the service did not respond (${result.error})`;
  }
}

export type StrataServiceState =
  | "starting" | "loading" | "ready" | "busy" | "unloaded" | "unreachable" | "stopping" | "failed" | "unverified";

export function deriveStrataState(input: {
  stopping: boolean;
  httpSeen: boolean;
  poll: StrataPollResult | null;
}): { state: StrataServiceState; detail: string | null } {
  if (input.stopping) return { state: "stopping", detail: null };
  const poll = input.poll;
  if (!poll) return { state: input.httpSeen ? "unreachable" : "loading", detail: null };
  switch (poll.kind) {
    case "ok":
      if (!poll.status.loaded) return { state: "unloaded", detail: "model unloaded; the next request loads it" };
      return poll.status.inFlight > 0
        ? { state: "busy", detail: `${poll.status.inFlight} request(s) in flight` }
        : { state: "ready", detail: null };
    case "unauthorized":
      return { state: "unreachable", detail: "API key rejected by the service" };
    case "http-error":
      return { state: "unreachable", detail: `status endpoint returned HTTP ${poll.status}` };
    case "unreachable":
      return input.httpSeen
        ? { state: "unreachable", detail: poll.error }
        : { state: "loading", detail: null };
  }
}
