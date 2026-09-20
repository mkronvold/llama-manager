import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs-extra";

// Regression coverage for the "Start server detached" option (Options >
// Dashboard > startDetached): defaults to true, and loadConfig() must merge
// missing/legacy config files to that default without clobbering an
// explicit user override.
describe("config: server.startDetached option", () => {
  let tmpDir: string;
  let originalConfigEnv: string | undefined;
  let originalStateEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llama-manager-test-"));
    originalConfigEnv = process.env.XDG_CONFIG_HOME;
    originalStateEnv = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;
    process.env.XDG_STATE_HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalConfigEnv === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigEnv;
    if (originalStateEnv === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateEnv;
    await fs.remove(tmpDir).catch(() => {});
  });

  it("defaults to true", async () => {
    const { loadConfig } = await import("../config");
    const config = await loadConfig();
    expect(config.server.startDetached).toBe(true);
  });

  it("defaults to true when a legacy saved config predates the option", async () => {
    const { getConfigPath, loadConfig } = await import("../config");
    await fs.ensureDir(path.dirname(getConfigPath()));
    await fs.writeJson(getConfigPath(), {
      server: { logFile: null, profiles: {}, activeProfile: "Default" },
    });

    const config = await loadConfig();
    expect(config.server.startDetached).toBe(true);
  });

  it("respects an explicit false override in a saved config", async () => {
    const { getConfigPath, loadConfig } = await import("../config");
    await fs.ensureDir(path.dirname(getConfigPath()));
    await fs.writeJson(getConfigPath(), {
      server: { logFile: null, startDetached: false, profiles: {}, activeProfile: "Default" },
    });

    const config = await loadConfig();
    expect(config.server.startDetached).toBe(false);
  });
});
