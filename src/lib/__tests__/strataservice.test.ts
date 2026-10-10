import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  buildStrataEnvironment, checkIdentity, deriveStrataState, descendantsOf, isRecordGone,
  parseProcessSnapshot, parseStrataStatus, resolvePollHost, resolveStrataApiKey,
  fetchStrataMetrics,
} from "../strataservice";
import type { ProcessRecord } from "../strataservice";
import { createFileTail } from "../logtail";
import { metricsFixture } from "./fixtures/stratametrics";

const rec = (pid: number, ppid: number, createdAt: string, name = "python.exe", executable = `C:\\x\\${name}`): ProcessRecord =>
  ({ pid, ppid, createdAt, name, executable });

describe("Strata service helpers", () => {
  it("parses process snapshots, including empty creation times and pipes in odd lines", () => {
    const records = parseProcessSnapshot([
      "100|4|2025-01-01T00:00:00.0000000Z|python.exe|C:\\S\\.venv\\Scripts\\python.exe",
      "101|100||strata.exe|",
      "garbage",
      "0|0|x|Idle|",
    ].join("\r\n"));
    expect(records).toEqual([
      { pid: 100, ppid: 4, createdAt: "2025-01-01T00:00:00.0000000Z", name: "python.exe", executable: "C:\\S\\.venv\\Scripts\\python.exe" },
      { pid: 101, ppid: 100, createdAt: null, name: "strata.exe", executable: null },
    ]);
  });

  it("walks the venv launcher -> python -> engine tree and ignores PID-reuse orphans", () => {
    const records = [
      rec(10, 1, "2025-01-01T00:00:10Z"),
      rec(11, 10, "2025-01-01T00:00:11Z"),
      rec(12, 11, "2025-01-01T00:00:12Z", "strata.exe"),
      // claims parent 10 but predates it: 10 is a reused PID, not its parent
      rec(13, 10, "2025-01-01T00:00:05Z", "other.exe"),
    ];
    expect(descendantsOf(records, 10).map((r) => r.pid)).toEqual([11, 12]);
  });

  it("verifies identity by PID, creation time and executable", () => {
    const records = [rec(10, 1, "2025-01-01T00:00:10.0000000Z", "python.exe", "C:\\S\\.venv\\Scripts\\python.exe")];
    const expected = { pid: 10, createdAt: "2025-01-01T00:00:10.000Z", executable: "c:\\s\\.venv\\scripts\\python.exe" };
    expect(checkIdentity(records, expected).kind).toBe("verified");
    expect(checkIdentity(records, { ...expected, createdAt: "2025-01-01T00:00:11Z" })).toMatchObject({ kind: "mismatch" });
    expect(checkIdentity(records, { ...expected, executable: "C:\\other\\python.exe" })).toMatchObject({ kind: "mismatch" });
    expect(checkIdentity(records, { ...expected, createdAt: null })).toMatchObject({ kind: "mismatch" });
    expect(checkIdentity([], expected).kind).toBe("gone");
    expect(isRecordGone(records, rec(10, 1, "2025-01-01T00:00:10Z"))).toBe(false);
    expect(isRecordGone(records, rec(10, 1, "2025-01-02T00:00:00Z"))).toBe(true);
  });

  it("polls wildcard binds through loopback and brackets IPv6", () => {
    expect(resolvePollHost("0.0.0.0")).toBe("127.0.0.1");
    expect(resolvePollHost("::")).toBe("127.0.0.1");
    expect(resolvePollHost("192.168.1.20")).toBe("192.168.1.20");
    expect(resolvePollHost("::1")).toBe("[::1]");
    expect(resolvePollHost("[fe80::1]")).toBe("[fe80::1]");
  });

  it("passes only the profile key through the environment", () => {
    const env = buildStrataEnvironment({ PATH: "p", strata_api_key: "inherited" }, null);
    expect(env).toEqual({ PATH: "p", PYTHONIOENCODING: "utf-8" });
    expect(buildStrataEnvironment({ PATH: "p" }, "k").STRATA_API_KEY).toBe("k");
    expect(resolveStrataApiKey(" k ", "c")).toEqual({ key: "k", source: "profile" });
    expect(resolveStrataApiKey("", "c")).toEqual({ key: "c", source: "config" });
    expect(resolveStrataApiKey(null, null)).toEqual({ key: null, source: "none" });
  });

  it("separates loading, ready, busy, unloaded and unreachable", () => {
    const ok = (loaded: boolean, inFlight = 0) => ({ kind: "ok" as const, status: { ...parseStrataStatus({ loaded, activity: { in_flight: inFlight } }) } });
    expect(deriveStrataState({ stopping: false, httpSeen: false, poll: { kind: "unreachable", error: "refused" } }).state).toBe("loading");
    expect(deriveStrataState({ stopping: false, httpSeen: true, poll: { kind: "unreachable", error: "refused" } }).state).toBe("unreachable");
    expect(deriveStrataState({ stopping: false, httpSeen: true, poll: ok(true) }).state).toBe("ready");
    expect(deriveStrataState({ stopping: false, httpSeen: true, poll: ok(true, 2) }).state).toBe("busy");
    expect(deriveStrataState({ stopping: false, httpSeen: true, poll: ok(false) }).state).toBe("unloaded");
    expect(deriveStrataState({ stopping: false, httpSeen: true, poll: { kind: "unauthorized" } }).detail).toMatch(/API key/);
    expect(deriveStrataState({ stopping: true, httpSeen: true, poll: ok(true) }).state).toBe("stopping");
  });
});

describe("stock metrics HTTP", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses requests=all, auth, abort signal and manual redirects", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(metricsFixture()));
    const controller = new AbortController();
    expect((await fetchStrataMetrics("http://127.0.0.1:1234", "test-key", controller.signal)).count).toBe(1);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:1234/metrics?requests=all",
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" }, redirect: "manual", signal: expect.any(AbortSignal) }));
  });

  it.each([401, 403, 302, 500])("surfaces HTTP %i without success fallback", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    await expect(fetchStrataMetrics("http://127.0.0.1:1234", null, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects malformed bodies and transport errors", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    await expect(fetchStrataMetrics("http://127.0.0.1:1234", null, new AbortController().signal)).rejects.toThrow(/totals/);
    fetcher.mockRejectedValue(new Error("unreachable"));
    await expect(fetchStrataMetrics("http://127.0.0.1:1234", null, new AbortController().signal)).rejects.toThrow("unreachable");
  });
});

describe("file tail", () => {
  let temp: string;
  beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "logtail-")); });
  afterEach(async () => { await fs.remove(temp); });

  it("starts at an offset, holds partial lines, decodes split UTF-8 and survives truncation", async () => {
    const file = path.join(temp, "engine.log");
    await fs.writeFile(file, "earlier run\r\n");
    const offset = (await fs.stat(file)).size;
    const lines: string[] = [];
    const tail = createFileTail(file, offset, (l) => lines.push(l), 20);
    const euro = Buffer.from("€", "utf-8");
    await fs.appendFile(file, Buffer.concat([Buffer.from("price "), euro.subarray(0, 1)]));
    tail.drainSync();
    await fs.appendFile(file, Buffer.concat([euro.subarray(1), Buffer.from("\r\npart")]));
    tail.drainSync();
    expect(lines).toEqual(["price €"]);
    await fs.writeFile(file, "fresh\n");
    tail.drainSync();
    tail.stop(true);
    expect(lines).toEqual(["price €", "fresh"]);
  });

  it("flushes a final partial line on stop", async () => {
    const file = path.join(temp, "out.log");
    await fs.writeFile(file, "a\nb");
    const lines: string[] = [];
    const tail = createFileTail(file, 0, (l) => lines.push(l), 20);
    tail.stop(true);
    expect(lines).toEqual(["a", "b"]);
  });
});
