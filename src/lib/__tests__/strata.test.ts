import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { buildStrataLaunchSpec, inspectStrata, registerStrataInstallation } from "../strata";
import { getRuntimeAdapter, strataVersionId, validateStrataInstallations } from "../runtime";
import { listVersions, switchVersion, uninstallVersion } from "../versions";
import type { ConfigData } from "../config";
import * as versionsModule from "../versions";
import { VersionsControl } from "../../ui/tabs/VersionsTab";
import { Framebuffer } from "../framebuffer";
import { FramebufferCanvas } from "../framebuffer-canvas";
import type { TabContext } from "../tabcontext";

class InspectableVersions extends VersionsControl {
  selectFirst(): void { this._table.selectedIndex = 0; }
  snapshot() {
    const row = this._table.getSelectedItem();
    return {
      updateDisabled: this._btnUpdate.disabled,
      deleteLabel: this._btnDelete.label,
      panelTitle: this._changelogSection.title,
      panelVisible: this._changelogSection.visible,
      cells: this._table.columns.map((column) => column.format?.("", row?.data)),
    };
  }
}

describe("Strata registration and inspection", () => {
  let temp: string;
  let root: string;
  let config: ConfigData;
  const runner = vi.fn(async (_exe: string, args: string[]) =>
    args[0] === "rev-parse" ? "82f46a8c8f475f001ad76d92f58f4a4f8ffb0253" :
      args[0] === "tag" ? "v0.1.40.1" : "");

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "strata-registration-"));
    root = path.join(temp, "Strata with spaces");
    vi.stubEnv("XDG_CONFIG_HOME", temp);
    vi.stubEnv("XDG_STATE_HOME", path.join(temp, "state"));
    vi.stubEnv("XDG_DATA_HOME", path.join(temp, "data"));
    vi.resetModules();
    runner.mockClear();
    const { loadConfig } = await import("../config");
    config = structuredClone(await loadConfig());
    config.versionsDir = path.join(temp, "uncreated versions");
    for (const file of [
      "serve\\server.py", "setup.py", ".venv\\Scripts\\python.exe", ".git\\HEAD",
      "engine\\strata.exe", "pack\\index.txt", "pack\\dense.bin", "pack\\native_experts.txt",
      "tokenizer\\vocab.json", "tokenizer\\merges.txt", "tokenizer\\token_type.json",
      "models\\model-00001-of-00002.gguf", "models\\model-00002-of-00002.gguf",
    ]) {
      await fs.outputFile(path.join(root, ...file.split("\\")), "fixture");
    }
    await fs.ensureDir(path.join(root, "engine", "rocm", "bin"));
    await fs.outputJson(path.join(root, "engine", "BUILD.json"), {
      backend: "hip", platform: "windows-x64", version: "0.1.40", archs: ["gfx1151"],
      lib_dirs: ["rocm/bin"],
    });
    await fs.outputJson(path.join(root, "strata-model.json"), {
      backend: "hip", model_name: "qwen3.8-test", cwd: ".",
      exe: path.join("engine", "strata.exe"), tokenizer: "tokenizer",
      args: ["--pack", "pack", "--native", path.join("models", "model-00001-of-00002.gguf")],
      lib_dirs: [path.join("engine", "rocm", "bin")],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.remove(temp);
  });

  it("keeps upstream settings ownership and disables Strata lifecycle", () => {
    expect(getRuntimeAdapter("strata").capabilities).toMatchObject({
      lifecycleAvailable: false, settingsOwner: "upstream", telemetry: "json-api",
      modelSelection: false, listDevices: false,
    });
    expect(getRuntimeAdapter("llama-compatible").capabilities.lifecycleAvailable).toBe(true);
  });

  it("inspects separate source and engine versions without launching inference", async () => {
    const result = await inspectStrata(root, runner);
    expect(result).toMatchObject({ ready: true, sourceTag: "v0.1.40.1", engineVersion: "0.1.40", backend: "hip" });
    expect(result.configs[0]?.issues).toEqual([]);
    expect(runner.mock.calls.every((call) => call[1][0] !== "-m")).toBe(true);
  });

  it("builds direct Python argv with space-containing paths and no llama flags", async () => {
    const inspection = await inspectStrata(root, runner);
    const spec = buildStrataLaunchSpec(inspection, path.join(root, "strata-model.json"), "127.0.0.1", 8096);
    expect(spec.executable).toBe(path.join(root, ".venv", "Scripts", "python.exe"));
    expect(spec.cwd).toBe(root);
    expect(spec.args).toEqual([
      "-u", "-m", "serve.server", "--engine", "strata", "--config",
      path.join(root, "strata-model.json"), "--host", "127.0.0.1", "--port", "8096",
    ]);
    expect(() => buildStrataLaunchSpec(inspection, "missing.json", "localhost", 8096)).toThrow("not usable");
    expect(() => buildStrataLaunchSpec(inspection, path.join(root, "strata-model.json"), "", 0)).toThrow("bind");
  });

  it.each([
    ["engine", "engine\\strata.exe"],
    ["tokenizer", "tokenizer\\vocab.json"],
    ["pack index", "pack\\index.txt"],
    ["dense pack", "pack\\dense.bin"],
    ["second GGUF shard", "models\\model-00002-of-00002.gguf"],
    ["library directory", "engine\\rocm\\bin"],
  ])("does not call a config usable with a missing %s", async (_label, missing) => {
    await fs.remove(path.join(root, ...missing.split("\\")));
    const result = await inspectStrata(root, runner);
    expect(result.ready).toBe(false);
    expect([...result.issues, ...result.configs.flatMap((item) => item.issues)].join("\n")).toContain(path.basename(path.join(...missing.split("\\"))));
  });

  it("surfaces malformed JSON and dependency failures", async () => {
    await fs.outputFile(path.join(root, "engine", "BUILD.json"), "{");
    await fs.outputFile(path.join(root, "strata-model.json"), "[]");
    const result = await inspectStrata(root, async () => { throw new Error("missing dependency"); });
    expect(result.ready).toBe(false);
    expect(result.issues.join("\n")).toContain("manifest");
    expect(result.issues.join("\n")).toContain("expected a JSON object");
    expect(result.issues.join("\n")).toContain("dependency check failed");
  });

  it("reports unsupported manifests and mismatched backends", async () => {
    await fs.outputJson(path.join(root, "engine", "BUILD.json"), {
      backend: "vulkan", platform: "linux-x64", version: "", archs: 42,
    });
    const result = await inspectStrata(root, runner);
    expect(result.ready).toBe(false);
    expect(result.issues.join("\n")).toContain("Unsupported");
    expect(result.configs[0]?.issues.join("\n")).toContain("backend");
  });

  it("keeps invalid roots inspectable instead of failing the entire Versions listing", async () => {
    const result = await inspectStrata(path.join(root, "setup.py"), runner);
    expect(result.ready).toBe(false);
    expect(result.issues.join("\n")).toContain("Expected directory");
    expect(result.configs).toEqual([]);
  });

  it("registers once and lists it even when no legacy versions directory exists", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    await registerStrataInstallation(config, root, runner);
    await expect(registerStrataInstallation(config, path.join(root, "."), runner)).rejects.toThrow("already registered");
    const versions = await listVersions(config, runner);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      runtime: "strata", active: false, fork: "strata", tag: "v0.1.40.1",
      strata: { engineVersion: "0.1.40", ready: true },
    });
  });

  it("lists incomplete installations with actionable diagnostics", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    await registerStrataInstallation(config, root, runner);
    await fs.remove(path.join(root, ".venv"));
    const versions = await listVersions(config, runner);
    expect(versions[0]?.strata?.ready).toBe(false);
    expect(versions[0]?.strata?.issues.join("\n")).toContain("python.exe");
  });

  it("rejects non-Windows registration and relative roots", async () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    await expect(registerStrataInstallation(config, root, runner)).rejects.toThrow("Windows only");
    vi.mocked(os.platform).mockReturnValue("win32");
    await expect(registerStrataInstallation(config, "relative", runner)).rejects.toThrow("absolute");
  });

  it("blocks activation and unregisters without deleting any installation/model files", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    await registerStrataInstallation(config, root, runner);
    const id = strataVersionId(config.strataInstallations![0]!.id);
    await expect(switchVersion(config, id)).rejects.toThrow("inspection only");
    await uninstallVersion(config, id);
    expect(config.strataInstallations).toEqual([]);
    expect(await fs.pathExists(path.join(root, "pack", "dense.bin"))).toBe(true);
    expect(await fs.pathExists(path.join(root, "models", "model-00002-of-00002.gguf"))).toBe(true);
    await expect(uninstallVersion(config, id)).rejects.toThrow("Unknown");
  });

  it("rejects a manually selected Strata ID before llama argument building or spawning", async () => {
    const { buildArgs, startServer, getStatus } = await import("../server");
    config.activeVersion = strataVersionId("test");
    expect(() => buildArgs(config, path.join(temp, "unused.log"))).toThrow("does not accept");
    await expect(startServer(config)).rejects.toThrow("lifecycle support");
    expect(getStatus().running).toBe(false);
    expect(await fs.pathExists(path.join(temp, "state", "session.json"))).toBe(false);
  });

  it("defaults legacy configuration and persists registration independently of profiles", async () => {
    const { getConfigPath, loadConfig, saveConfig } = await import("../config");
    expect((await loadConfig()).strataInstallations).toEqual([]);
    await fs.outputJson(getConfigPath(), { ...config, strataInstallations: undefined });
    expect((await loadConfig()).strataInstallations).toEqual([]);
    vi.spyOn(os, "platform").mockReturnValue("win32");
    await registerStrataInstallation(config, root, runner);
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded.strataInstallations).toEqual(config.strataInstallations);
    expect(loaded.server.profiles).toEqual(config.server.profiles);
    expect(loaded.activeVersion).toBe(config.activeVersion);
  });

  it("rejects malformed or duplicate persisted registrations instead of resetting user config", async () => {
    const { getConfigPath, loadConfig } = await import("../config");
    await fs.outputJson(getConfigPath(), { strataInstallations: [{ root }] });
    await expect(loadConfig()).rejects.toThrow("Invalid Strata registration");
    const entry = { id: "one", root, ownership: "external", registeredAt: new Date().toISOString() };
    expect(() => validateStrataInstallations([entry, entry])).toThrow("Duplicate");
    expect(() => validateStrataInstallations(null)).toThrow("array");
    expect(() => validateStrataInstallations([{ ...entry, root: "relative" }])).toThrow("Invalid");
    expect(() => validateStrataInstallations([{ ...entry, registeredAt: "invalid" }])).toThrow("Invalid");
  });

  it("presents Strata identity/diagnostics and excludes it from generic updates in Versions", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    await registerStrataInstallation(config, root, runner);
    const rows = await listVersions(config, runner);
    vi.spyOn(versionsModule, "listVersions").mockResolvedValue(rows);
    const remote = vi.spyOn(versionsModule, "listRecentVersions");
    const messages = vi.fn();
    const ctx: TabContext = {
      canvas: new FramebufferCanvas(new Framebuffer()),
      getConfig: () => config, setConfig: (value) => { config = value; },
      showMessage: messages, forceRender: () => {}, scheduleRender: () => {},
      showCursor: () => {}, setTextInputFocused: () => {},
      openModal: async () => { throw new Error("No modal expected"); }, closeModal: () => {},
    };
    const control = new InspectableVersions(ctx);
    await control.refreshLocal();
    control.selectFirst();
    await control.refreshLocal();
    expect(control.snapshot()).toMatchObject({
      updateDisabled: true, deleteLabel: "Unregister",
      panelTitle: "Strata Inspection", panelVisible: true,
      cells: ["  v0.1.40.1", "0.1.40", "HIP/Radeon / inspected", "Strata", expect.any(String)],
    });
    await control.updateSelected();
    await control.updateAll();
    expect(remote).not.toHaveBeenCalled();
    expect(messages.mock.calls.flat().join("\n")).toContain("not checked");
    control.onDestroy();
  });
});
