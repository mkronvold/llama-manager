import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "fs-extra";
import type { ConfigData } from "../config";
import type { StrataInspection } from "../strata";

// A stand-in for `python -m serve.server`: prints [strata]/ready: lines, serves
// /v1/status and /v1/unload (409 when FAKE_BUSY is set) and owns a child "engine"
// process, like the real venv launcher -> python -> strata.exe tree.
const FAKE_SERVICE = `
import http from "node:http";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const arg = (n) => argv[argv.indexOf(n) + 1];
const host = arg("--host"), port = Number(arg("--port"));
const busy = !!process.env.FAKE_BUSY;
const key = process.env.STRATA_API_KEY || null;
console.log("[strata] loading fake model (key " + (key ? "set" : "none") + ")");
let engine = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
let loaded = true;
const server = http.createServer((req, res) => {
  if (key && req.headers.authorization !== "Bearer " + key) { res.writeHead(401); res.end(); return; }
  if (req.url === "/v1/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ loaded, model: "fake-model", activity: { in_flight: busy ? 1 : 0 } }));
    return;
  }
  if (req.url === "/v1/unload" && req.method === "POST") {
    if (busy) { res.writeHead(409, { "content-type": "application/json" }); res.end('{"error":{"type":"model_busy"}}'); return; }
    if (!process.env.FAKE_KEEP_ENGINE) { engine?.kill(); engine = null; }
    loaded = false;
    console.log("model unloaded; the next request loads it again");
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"unloaded"}');
    return;
  }
  res.writeHead(404); res.end();
});
setTimeout(() => server.listen(port, host, () => console.log("ready: http://" + host + ":" + port)), 300);
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(os.platform() !== "win32")("Strata session lifecycle", () => {
  let temp: string;
  let config: ConfigData;
  let port: number;
  let script: string;
  let cfgFile: string;
  let engineLog: string;
  let extraEnv: Record<string, string>;
  let server: typeof import("../server");
  let session: typeof import("../stratasession");
  let cfgMod: typeof import("../config");
  const strays: number[] = [];

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "strata-session-"));
    vi.stubEnv("XDG_CONFIG_HOME", temp);
    vi.stubEnv("XDG_STATE_HOME", path.join(temp, "state"));
    vi.stubEnv("XDG_DATA_HOME", path.join(temp, "data"));
    vi.resetModules();
    cfgMod = await import("../config");
    const prof = await import("../strataprofile");
    server = await import("../server");
    session = await import("../stratasession");

    port = await freePort();
    script = path.join(temp, "fake service.mjs");
    await fs.writeFile(script, FAKE_SERVICE);
    cfgFile = path.join(temp, "strata-fake.json");
    engineLog = path.join(temp, "engine.log");
    await fs.writeJson(cfgFile, { model_name: "fake-model", backend: "hip", args: ["--max-context", "8192", "--kv", "int8"] });
    await fs.writeFile(engineLog, "earlier run line\n");
    extraEnv = {};

    config = structuredClone(await cfgMod.loadConfig());
    config.strataInstallations = [{ id: "fake", root: temp, ownership: "external", registeredAt: "" }];
    const profile = prof.buildStrataProfile(undefined, { installationId: "fake", configPath: cfgFile });
    profile.presets.server.host = "127.0.0.1";
    profile.presets.server.port = port;
    config.server.profiles["strata-fake"] = profile;
    config.server.activeProfile = "strata-fake";
    config.dashboard.pollIntervalMs = 200;

    const inspection: StrataInspection = {
      root: temp, python: process.execPath, sourceRevision: null, sourceTag: null, engineVersion: null,
      backend: "hip", architectures: [], issues: [], ready: true,
      configs: [{
        path: path.resolve(cfgFile), model: "fake-model", executable: process.execPath, args: [], cwd: temp,
        tokenizer: "", log: engineLog, libDirs: [], issues: [],
      }],
    };
    session.setStrataSessionDeps({
      inspect: async () => inspection,
      buildLaunch: (_i, _c, host, p) => ({
        executable: process.execPath, args: [script, "--host", host, "--port", String(p)], cwd: temp, environment: extraEnv,
      }),
      engineExitTimeoutMs: 5000, verifyTimeoutMs: 10_000, unloadTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await server.stopServer({ mode: "force" }).catch(() => undefined);
    session.resetStrataSessionForTests();
    for (const pid of strays.splice(0)) { try { process.kill(pid); } catch { /* gone */ } }
    vi.unstubAllEnvs();
    await fs.remove(temp).catch(() => undefined);
  });

  async function readMarker(): Promise<Record<string, unknown>> {
    return fs.readJson(cfgMod.getSessionFile());
  }

  it("starts, reports ready, tags logs and stops cooperatively without orphans", async () => {
    config.server.profiles["strata-fake"]!.presets.server.apiKey = "sekret-key";
    const lines: string[] = [];
    server.onServerLog((l) => lines.push(l));
    const pid = await server.startServer(config);
    await fs.appendFile(engineLog, "this run line\n");

    const marker = await readMarker();
    expect(marker).toMatchObject({ version: 2, runtime: "strata", pid, profileName: "strata-fake", host: "127.0.0.1", port, pollHost: "127.0.0.1", keySource: "profile" });
    expect(JSON.stringify(marker)).not.toContain("sekret-key");

    await until(() => server.getStatus().state === "ready");
    expect(server.getStatus()).toMatchObject({ running: true, runtime: "strata", pid });
    await until(() => lines.some((l) => l.startsWith("[engine] this run line")));
    expect(lines).toContain("[out] [strata] loading fake model (key set)");
    expect(lines.some((l) => l.startsWith("[out] ready: http://"))).toBe(true);
    expect(lines.some((l) => l.includes("earlier run line"))).toBe(false);
    expect(server.isStrataInstallationInUse("fake")).toBe(true);
    await expect(server.startServer(config)).rejects.toThrow(/already running/);

    const result = await server.stopServer({ mode: "graceful" });
    expect(result).toEqual({ ok: true, forced: false, reason: undefined });
    expect(alive(pid)).toBe(false);
    expect(await fs.pathExists(cfgMod.getSessionFile())).toBe(false);
    expect(server.getStatus()).toMatchObject({ running: false, runtime: null });
    const { checkPortAvailable } = await import("../strataservice");
    expect(await checkPortAvailable("127.0.0.1", port)).toBeNull();
  }, 60_000);

  it("refuses a busy graceful stop, then force-stops on request", async () => {
    extraEnv = { FAKE_BUSY: "1" };
    const pid = await server.startServer(config);
    await until(() => server.getStatus().state === "busy");
    const refused = await server.stopServer({ mode: "graceful" });
    expect(refused).toMatchObject({ ok: false, canForce: true });
    expect(refused.ok ? "" : refused.reason).toMatch(/busy/i);
    expect(alive(pid)).toBe(true);
    expect(server.getStatus().running).toBe(true);

    const forced = await server.stopServer({ mode: "force-on-failure" });
    expect(forced).toMatchObject({ ok: true, forced: true });
    expect(alive(pid)).toBe(false);
    expect(await fs.pathExists(cfgMod.getSessionFile())).toBe(false);
  }, 60_000);

  it("reattaches a verified session after a manager restart and stops it (--stop path)", async () => {
    const pid = await server.startServer(config);
    await until(() => server.getStatus().state === "ready");
    session.resetStrataSessionForTests();
    expect(server.getStatus().running).toBe(false);

    const detected = server.detectExistingSession({ monitor: false, config });
    expect(detected).toEqual({ pid, runtime: "strata", verified: true });
    expect(server.getStatus()).toMatchObject({ running: true, pid, runtime: "strata" });
    const result = await server.stopServer({ mode: "force-on-failure" });
    expect(result.ok).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it("never kills a PID whose identity does not match the marker", async () => {
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    other.unref();
    strays.push(other.pid!);
    await fs.outputJson(cfgMod.getSessionFile(), {
      version: 2, runtime: "strata", sessionId: "x", pid: other.pid, pidCreatedAt: "2001-01-01T00:00:00.000Z",
      executable: process.execPath, engineExecutable: null, startedAt: Date.now(), installationId: "fake",
      installationRoot: temp, profileName: "strata-fake", configPath: cfgFile, host: "127.0.0.1", port, pollHost: "127.0.0.1",
      logFiles: { out: path.join(temp, "o.log"), err: path.join(temp, "o.err"), engine: null, engineStart: 0 }, keySource: "none",
    });
    const detected = server.detectExistingSession({ monitor: true, config });
    expect(detected).toMatchObject({ pid: other.pid, runtime: "strata", verified: false });
    expect(server.getStatus()).toMatchObject({ running: false, unverified: true, state: "unverified" });
    expect(server.isStrataInstallationInUse("fake")).toBe(true);

    expect(await server.stopServer({ mode: "force" })).toMatchObject({ ok: false, canForce: false });
    server.stopServerOnExit();
    await expect(server.startServer(config)).rejects.toThrow(/unverified/);
    expect(alive(other.pid!)).toBe(true);

    expect(server.clearUnverifiedSession()).toBe(true);
    expect(await fs.pathExists(cfgMod.getSessionFile())).toBe(false);
    expect(alive(other.pid!)).toBe(true);
  }, 60_000);

  it("force-stops synchronously on exit (killServerOnExit) and never touches unverified PIDs", async () => {
    const pid = await server.startServer(config);
    await until(() => server.getStatus().state === "ready");
    server.stopServerOnExit();
    await until(() => !alive(pid), 10_000);
    expect(await fs.pathExists(cfgMod.getSessionFile())).toBe(false);
  }, 60_000);

  it("treats an engine that survives unload as a failed graceful stop", async () => {
    extraEnv = { FAKE_KEEP_ENGINE: "1" };
    session.setStrataSessionDeps({ engineExitTimeoutMs: 1500 });
    const pid = await server.startServer(config);
    await until(() => server.getStatus().state === "ready");
    const refused = await server.stopServer({ mode: "graceful" });
    expect(refused).toMatchObject({ ok: false, canForce: true });
    expect(refused.ok ? "" : refused.reason).toMatch(/engine did not exit/);
    expect(alive(pid)).toBe(true);
    expect(server.getStatus()).toMatchObject({ running: true });
    expect(server.getStatus().state).not.toBe("stopping");

    const forced = await server.stopServer({ mode: "force-on-failure" });
    expect(forced).toMatchObject({ ok: true, forced: true });
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it("restores state and polling when the pre-kill identity check fails", async () => {
    const { windowsProcessSnapshot } = await import("../strataservice");
    const pid = await server.startServer(config);
    await until(() => server.getStatus().state === "ready");
    session.setStrataSessionDeps({
      processes: { ...windowsProcessSnapshot, snapshot: async () => { throw new Error("cim down"); } },
    });
    const result = await server.stopServer({ mode: "force" });
    expect(result).toMatchObject({ ok: false, canForce: true });
    expect(alive(pid)).toBe(true);
    expect(server.getStatus()).toMatchObject({ running: true, state: "ready" });
    session.setStrataSessionDeps({ processes: windowsProcessSnapshot });
  }, 60_000);

  it("keeps the marker when the exit-time force stop cannot confirm termination", async () => {
    const pid = await server.startServer(config);
    await until(() => server.getStatus().state === "ready");
    session.setStrataSessionDeps({ terminateTree: () => undefined, verifyTimeoutMs: 500 });
    server.stopServerOnExit();
    expect(alive(pid)).toBe(true);
    expect(await fs.pathExists(cfgMod.getSessionFile())).toBe(true);
    session.resetStrataSessionDeps();
    expect(await server.stopServer({ mode: "force" })).toMatchObject({ ok: true });
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it("ignores an unreadable versioned marker instead of treating it as llama", async () => {
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    other.unref();
    strays.push(other.pid!);
    await fs.outputJson(cfgMod.getSessionFile(), { version: 3, runtime: "future", pid: other.pid });
    expect(server.detectExistingSession({ config })).toBeNull();
    await server.stopServer();
    expect(alive(other.pid!)).toBe(true);
  });

  it("refuses to start on a port that is already listening", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", () => r()));
    try {
      await expect(server.startServer(config)).rejects.toThrow(/already in use/);
      expect(await fs.pathExists(cfgMod.getSessionFile())).toBe(false);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
