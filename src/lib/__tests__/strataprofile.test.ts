import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import type { ConfigData, ServerProfile } from "../config";
import type { StrataInstallation } from "../runtime";
import {
  buildStrataLaunchCommand,
  buildStrataWrapperScript,
  finalizeStrataOp,
  listStrataOps,
  psQuote,
  reconcileStrataOp,
  startStrataOp,
  strataToolArgs,
  StrataOpBlockedError,
  type StrataOpMarker,
} from "../strataops";

describe("Strata profiles and tool runs", () => {
  let temp: string;
  let config: ConfigData;
  let cfgMod: typeof import("../config");
  let prof: typeof import("../strataprofile");
  let server: typeof import("../server");

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "strata-profiles-"));
    vi.stubEnv("XDG_CONFIG_HOME", temp);
    vi.stubEnv("XDG_STATE_HOME", path.join(temp, "state"));
    vi.stubEnv("XDG_DATA_HOME", path.join(temp, "data"));
    vi.resetModules();
    cfgMod = await import("../config");
    prof = await import("../strataprofile");
    server = await import("../server");
    config = structuredClone(await cfgMod.loadConfig());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.remove(temp);
  });

  const binding = () => ({ installationId: "halo", configPath: path.join(temp, "strata-model.json") });

  describe("profile binding", () => {
    it("round-trips a binding and leaves legacy profiles unchanged", async () => {
      const legacy = structuredClone(config.server.profiles.Default);
      config.server.profiles["strata-halo"] = prof.buildStrataProfile(config.server.profiles.Default, binding());
      await cfgMod.saveConfig(config);
      const loaded = await cfgMod.loadConfig();
      expect(loaded.server.profiles["strata-halo"]!.strata).toEqual(binding());
      expect(loaded.server.profiles.Default).toEqual(legacy);
      expect("strata" in loaded.server.profiles.Default!).toBe(false);
      expect(cfgMod.profilesUsingStrataInstallation(loaded, "halo")).toEqual(["strata-halo"]);
    });

    it("rejects invalid bindings on save and load", async () => {
      config.server.profiles.bad = { ...structuredClone(config.server.profiles.Default!), strata: { installationId: "", configPath: null } };
      await expect(cfgMod.saveConfig(config)).rejects.toThrow();
      await fs.outputJson(path.join(temp, "config.json"), {
        ...config,
        server: { ...config.server, profiles: { ...config.server.profiles, bad: { presets: {}, strata: { installationId: "x", configPath: "relative.json" } } } },
      });
      vi.resetModules();
      const fresh = await import("../config");
      await expect(fresh.loadConfig()).rejects.toThrow();
    });

    it("keeps the binding when a profile is deep-cloned (Duplicate)", () => {
      const original = prof.buildStrataProfile(undefined, binding());
      const copy = JSON.parse(JSON.stringify(original)) as ServerProfile;
      expect(copy.strata).toEqual(original.strata);
      expect(copy.strata).not.toBe(original.strata);
    });

    it("falls back to 0.0.0.0:1234 for unset or llama-default endpoints", () => {
      const p = prof.buildStrataProfile(config.server.profiles.Default, binding());
      expect(p.presets.server.host).toBe("0.0.0.0");
      expect(p.presets.server.port).toBe(1234);
      expect(p.presets.server.apiKey).toBeNull();
      expect(p.freeFormArgs).toEqual([]);
      expect(prof.buildStrataProfile(undefined, binding()).presets.server).toMatchObject({ host: "0.0.0.0", port: 1234 });
    });

    it("copies custom endpoint and key from the source profile", () => {
      const source = structuredClone(config.server.profiles.Default!);
      source.presets.server = { ...source.presets.server, host: "192.168.1.20", port: 9000, apiKey: "secret" };
      const p = prof.buildStrataProfile(source, binding());
      expect(p.presets.server).toMatchObject({ host: "192.168.1.20", port: 9000, apiKey: "secret" });
      expect(prof.strataExposureWarning(p)).toBeNull();
    });

    it("warns about non-loopback binds without any API key", () => {
      const p = prof.buildStrataProfile(undefined, binding());
      expect(prof.strataExposureWarning(p)).toMatch(/0\.0\.0\.0/);
      expect(prof.strataExposureWarning(p, true)).toBeNull();
      p.presets.server.host = "127.0.0.1";
      expect(prof.strataExposureWarning(p)).toBeNull();
      expect(prof.isLoopbackHost("[::1]")).toBe(true);
    });

    it("shows only host, port and apiKey fields", () => {
      expect(prof.isPresetFieldVisibleForStrata("server", "host")).toBe(true);
      expect(prof.isPresetFieldVisibleForStrata("server", "apiKey")).toBe(true);
      expect(prof.isPresetFieldVisibleForStrata("server", "threads")).toBe(false);
      expect(prof.isPresetFieldVisibleForStrata("model", "model")).toBe(false);
      expect(prof.strataFieldDefault("server", "port")).toBe(1234);
    });

    it("lists referencing profiles in the unregister warning", () => {
      expect(prof.strataUnregisterMessage(config, "halo", "C:\\Strata")).not.toMatch(/Profiles using it/);
      config.server.profiles.a = prof.buildStrataProfile(undefined, binding());
      config.server.profiles.b = prof.buildStrataProfile(undefined, binding());
      expect(prof.strataUnregisterMessage(config, "halo", "C:\\Strata")).toMatch(/Profiles using it.*: a, b\./);
    });

    it("reports binding status", async () => {
      const b = binding();
      expect((await prof.getStrataProfileStatus(config, b)).kind).toBe("installation-missing");
      config.strataInstallations = [{ id: "halo" } as StrataInstallation];
      expect((await prof.getStrataProfileStatus(config, { ...b, configPath: null })).kind).toBe("config-unset");
      expect((await prof.getStrataProfileStatus(config, b)).kind).toBe("config-missing");
      await fs.outputJson(b.configPath!, {});
      expect((await prof.getStrataProfileStatus(config, b)).kind).toBe("ok");
    });
  });

  describe("config summary", () => {
    it("parses requested settings with basenamed paths", async () => {
      const file = path.join(temp, "strata-x.json");
      await fs.outputJson(file, {
        model_name: "qwen", backend: "hip", port: 8080, api_key: "k",
        tokenizer: "C:\\s\\tokenizer",
        args: ["--pack", "C:\\s\\pack", "--max-context", "204800", "--mtp"],
        lib_dirs: ["engine\\rocm\\bin"],
      });
      const s = await prof.readStrataConfigSummary(file);
      expect(s).toMatchObject({ model: "qwen", backend: "hip", configPort: 8080, hasConfigApiKey: true, error: null });
      expect(s.settings).toEqual([
        { key: "pack", value: "pack" },
        { key: "max-context", value: "204800" },
        { key: "mtp", value: "on" },
        { key: "tokenizer", value: "tokenizer" },
        { key: "lib_dirs", value: "engine\\rocm\\bin" },
      ]);
      expect(await prof.listStrataConfigFiles(temp)).toEqual([file]);
    });

    it("never throws on broken files", async () => {
      const file = path.join(temp, "strata-bad.json");
      await fs.outputFile(file, "{not json");
      expect((await prof.readStrataConfigSummary(file)).error).toBeTruthy();
      expect((await prof.readStrataConfigSummary(path.join(temp, "missing.json"))).error).toBeTruthy();
    });
  });

  describe("llama guards", () => {
    it("refuses to start or list devices for a Strata profile", async () => {
      config.server.profiles["strata-halo"] = prof.buildStrataProfile(undefined, binding());
      config.server.activeProfile = "strata-halo";
      await expect(server.startServer(config)).rejects.toThrow(/Strata/);
      expect(server.listDevices(config)).toMatch(/Check\/Configure/);
      expect(() => server.buildArgs(config, path.join(temp, "x.log"))).toThrow(/Strata/);
    });
  });
});

describe("Strata tool runs", () => {
  let opsDir: string;
  let clock: number;
  let alive: Set<number>;
  const installation = { id: "halo", root: "C:\\Strata dir" } as StrataInstallation;
  const deps = () => ({ opsDir, now: () => clock, isPidAlive: (pid: number) => alive.has(pid), launchWindow: vi.fn(async () => undefined) });

  beforeEach(async () => {
    opsDir = await fs.mkdtemp(path.join(os.tmpdir(), "strata-ops-"));
    clock = Date.parse("2025-01-01T00:00:00Z");
    alive = new Set();
  });

  afterEach(async () => {
    await fs.remove(opsDir);
  });

  const sidecar = (m: StrataOpMarker, ext: string, value: string) => fs.outputFile(path.join(opsDir, `${m.opId}.${ext}`), value);

  it("uses only the agreed upstream flags", () => {
    expect(strataToolArgs("check")).toEqual(["setup.py", "--check"]);
    expect(strataToolArgs("configure")).toEqual(["setup.py", "--setup", "--no-start", "--no-browser"]);
  });

  it("quotes paths with spaces and single quotes", () => {
    expect(buildStrataLaunchCommand("C:\\it's here\\x.ps1")).toContain(`'-File', '"C:\\it''s here\\x.ps1"')`);
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'");
    const script = buildStrataWrapperScript({
      root: "C:\\O'Neil dir", python: "C:\\O'Neil dir\\.venv\\Scripts\\python.exe",
      args: strataToolArgs("check"), pidFile: "C:\\s\\a.pid", exitFile: "C:\\s\\a.exit", title: "Check",
    });
    expect(script).toContain("Set-Location -LiteralPath 'C:\\O''Neil dir'");
    expect(script).toContain("& 'C:\\O''Neil dir\\.venv\\Scripts\\python.exe' 'setup.py' '--check'");
    expect(script).not.toMatch(/--yes/);
  });

  it("writes a BOM wrapper and marker, then tracks running -> completed", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "check", d);
    expect(d.launchWindow).toHaveBeenCalledOnce();
    const script = await fs.readFile(path.join(opsDir, `${m.opId}.ps1`), "utf8");
    expect(script.charCodeAt(0)).toBe(0xfeff);
    expect(m.state).toBe("starting");

    await sidecar(m, "pid", "4242");
    alive.add(4242);
    expect((await reconcileStrataOp(m, d)).state).toBe("running");

    await sidecar(m, "exit", "0");
    const exited = await reconcileStrataOp((await listStrataOps("halo", d))[0]!, d);
    expect(exited).toMatchObject({ state: "exited", exitCode: 0 });
    const done = await finalizeStrataOp(exited, async () => ({ ready: false }), d);
    expect(done.state).toBe("completed");
    expect(await fs.pathExists(path.join(opsDir, `${m.opId}.ps1`))).toBe(false);
    expect((await listStrataOps("halo", d))[0]!.state).toBe("completed");
  });

  it("marks configure exit 0 without a usable config as incomplete", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "configure", d);
    await sidecar(m, "exit", "0");
    const exited = await reconcileStrataOp(m, d);
    expect((await finalizeStrataOp(exited, async () => ({ ready: false }), d)).state).toBe("incomplete");
  });

  it("marks configure completed only after revalidation succeeds", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "configure", d);
    await sidecar(m, "exit", "0");
    const exited = await reconcileStrataOp(m, d);
    expect((await finalizeStrataOp(exited, async () => ({ ready: true }), d)).state).toBe("completed");
  });

  it("marks a non-zero exit as failed", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "check", d);
    await sidecar(m, "exit", "2");
    const done = await finalizeStrataOp(await reconcileStrataOp(m, d), async () => ({ ready: true }), d);
    expect(done).toMatchObject({ state: "failed", detail: "Exited with code 2" });
  });

  it("marks a closed window without exit code as abandoned", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "configure", d);
    await sidecar(m, "pid", "99");
    expect((await reconcileStrataOp(m, d)).state).toBe("abandoned");
  });

  it("marks a never-started window as abandoned after the grace period", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "check", d);
    expect((await reconcileStrataOp(m, d)).state).toBe("starting");
    clock += 121_000;
    expect((await reconcileStrataOp(m, d)).state).toBe("abandoned");
  });

  it("records a launch failure as failed", async () => {
    const d = { ...deps(), launchWindow: vi.fn(async () => { throw new Error("no powershell"); }) };
    const m = await startStrataOp(installation, "py.exe", "check", d);
    expect(m).toMatchObject({ state: "failed" });
    expect(m.detail).toMatch(/no powershell/);
  });

  it("allows one configure at a time and blocks check during configure", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "configure", d);
    await sidecar(m, "pid", "7");
    alive.add(7);
    await expect(startStrataOp(installation, "py.exe", "configure", d)).rejects.toBeInstanceOf(StrataOpBlockedError);
    await expect(startStrataOp(installation, "py.exe", "check", d)).rejects.toBeInstanceOf(StrataOpBlockedError);
    alive.delete(7);
    clock += 1000;
    expect((await startStrataOp(installation, "py.exe", "check", d)).state).toBe("starting");
  });

  it("blocks configure while a check runs but allows parallel checks", async () => {
    const d = deps();
    const m = await startStrataOp(installation, "py.exe", "check", d);
    await sidecar(m, "pid", "8");
    alive.add(8);
    clock += 1000;
    await expect(startStrataOp(installation, "py.exe", "configure", d)).rejects.toBeInstanceOf(StrataOpBlockedError);
    expect((await startStrataOp(installation, "py.exe", "check", d)).state).toBe("starting");
  });

  it("blocks configure while a service uses the installation", async () => {
    const d = { ...deps(), isServiceUsingInstallation: (id: string) => id === "halo" };
    await expect(startStrataOp(installation, "py.exe", "configure", d)).rejects.toThrow(/Stop the Strata service/);
    expect((await startStrataOp(installation, "py.exe", "check", d)).state).toBe("starting");
  });
});
