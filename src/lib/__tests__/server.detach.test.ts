import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs-extra";
import { spawn, ChildProcess } from "child_process";

// Regression tests for the "Exit Now" detach/reattach/--stop feature: a
// server left running via detached spawn should be discoverable (via a
// session marker file) and stoppable by a later llama-manager process that
// never spawned it itself (no in-memory ChildProcess handle available).
describe("detached session reattach", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llama-manager-test-"));
    originalEnv = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (originalEnv === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalEnv;
    await fs.remove(tmpDir).catch(() => {});
  });

  it("detects an existing detached session and can stop it by PID alone", async () => {
    const { getSessionFile } = await import("../config");
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    await fs.ensureDir(path.dirname(getSessionFile()));
    await fs.writeJson(getSessionFile(), {
      pid: child.pid,
      startedAt: Date.now(),
      activeVersion: "test-version",
      logFile: null,
    });

    const { detectExistingSession, getStatus, stopServer } = await import("../server");

    const session = detectExistingSession();
    expect(session?.pid).toBe(child.pid);

    const status = getStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);

    await stopServer();

    const stoppedStatus = getStatus();
    expect(stoppedStatus.running).toBe(false);
    expect(await fs.pathExists(getSessionFile())).toBe(false);
  }, 15000);

  it("clears a stale session marker file for a dead PID", async () => {
    const { getSessionFile } = await import("../config");
    const child: ChildProcess = spawn(process.execPath, ["-e", "process.exit(0);"], { stdio: "ignore" });
    const deadPid: number = await new Promise((resolve) => {
      child.on("exit", () => resolve(child.pid!));
    });

    await fs.ensureDir(path.dirname(getSessionFile()));
    await fs.writeJson(getSessionFile(), {
      pid: deadPid,
      startedAt: Date.now(),
      activeVersion: "test-version",
      logFile: null,
    });

    const { detectExistingSession, getStatus } = await import("../server");

    const session = detectExistingSession();
    expect(session).toBeNull();
    expect(getStatus().running).toBe(false);
    expect(await fs.pathExists(getSessionFile())).toBe(false);
  });

  it("reattaches scoped llama logs from the launch offset, excluding old-session tasks", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", tmpDir);
    vi.stubEnv("XDG_DATA_HOME", path.join(tmpDir, "data"));
    const { getSessionFile, loadConfig } = await import("../config");
    const { taskStore } = await import("../tasks");
    const server = await import("../server");
    const config = await loadConfig();
    config.tasksFile = path.join(tmpDir, "tasks.jsonl");
    config.server.logFile = path.join(tmpDir, "missing.log");
    await taskStore.init(config);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {},1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      const logFile = path.join(tmpDir, "scoped.log");
      const old = "slot release: id 0 | task 7 | stop processing: n_tokens = 20, truncated = 0\n";
      await fs.writeFile(logFile, old + "slot release: id 0 | task 1 | stop processing: n_tokens = 30, truncated = 0\n");
      await fs.outputJson(getSessionFile(), { pid: child.pid, startedAt: Date.now(),
        activeVersion: "test", logFile, logStart: Buffer.byteLength(old), sessionId: "scoped", profileName: "frozen" });
      server.detectExistingSession({ config });
      expect(taskStore.getRange(0, 10)).toHaveLength(1);
      expect(taskStore.getRange(0, 10)[0]).toMatchObject({ taskId: 1, sourceSession: "scoped", profile: "frozen" });
    } finally {
      await server.stopServer();
      taskStore.dispose();
    }
  }, 20_000);

  it("backfills log lines/model info from disk on reattach and keeps tailing new lines", async () => {
    const { getSessionFile } = await import("../config");
    const { getModelInfo } = await import("../../ui/specialized/LoadedModelPanel");

    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const logFile = path.join(tmpDir, "server.log");
    await fs.writeFile(
      logFile,
      "srv  load_model: loading model '/models/test-model-Q4_K_M.gguf'\n" +
      "common_param:   - Vulkan0 : Test GPU (23321 MiB, 10692 MiB free)\n" +
      "srv  llama_server: model loaded\n"
    );

    await fs.ensureDir(path.dirname(getSessionFile()));
    await fs.writeJson(getSessionFile(), {
      pid: child.pid,
      startedAt: Date.now(),
      activeVersion: "test-version",
      logFile,
    });

    const { detectExistingSession, serverLogLines } = await import("../server");

    detectExistingSession();

    // Backfill from the existing on-disk log content should happen
    // synchronously (before any file-tail interval fires), so the Dashboard's
    // Loaded Model panel and Logs tab reflect the already-running server
    // immediately rather than appearing empty until the next poll.
    expect(serverLogLines.some((l) => l.includes("test-model"))).toBe(true);
    expect(getModelInfo()?.name).toContain("test-model");

    // Simulate the still-running detached server appending a new log line;
    // the poll-based tailer should pick it up without needing a restart.
    await fs.appendFile(logFile, "some new appended log line\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(serverLogLines.some((l) => l.includes("some new appended log line"))).toBe(true);

    process.kill(child.pid!, "SIGTERM");
  }, 15000);

  it("backfills and tails the sibling .err file (raw stderr) on reattach, prefixed for the Logs tab", async () => {
    const { getSessionFile } = await import("../config");

    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const logFile = path.join(tmpDir, "server.log");
    const errFile = path.join(tmpDir, "server.err");
    await fs.writeFile(logFile, "srv  llama_server: model loaded\n");
    // Simulates a crash/assert written straight to stderr with fprintf,
    // which bypasses llama.cpp's own --log-file logger entirely.
    await fs.writeFile(errFile, "GGML_ASSERT: some_condition failed\n");

    await fs.ensureDir(path.dirname(getSessionFile()));
    await fs.writeJson(getSessionFile(), {
      pid: child.pid,
      startedAt: Date.now(),
      activeVersion: "test-version",
      logFile,
      errFile,
    });

    const { detectExistingSession, serverLogLines } = await import("../server");

    detectExistingSession();

    // The stderr backfill is prefixed so it's distinguishable inline in the
    // merged Logs tab view without needing a separate UI surface.
    expect(serverLogLines.some((l) => l === "[stderr] GGML_ASSERT: some_condition failed")).toBe(true);

    // New stderr output (e.g. a later crash) should keep showing up too.
    await fs.appendFile(errFile, "another stderr line\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(serverLogLines.some((l) => l === "[stderr] another stderr line")).toBe(true);

    process.kill(child.pid!, "SIGTERM");
  }, 15000);
});
