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
});
