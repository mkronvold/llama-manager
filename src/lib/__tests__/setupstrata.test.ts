import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import fs from "fs-extra";
import path from "node:path";
import type { ConfigData } from "../config";
import { addSetupStrataProfile } from "../setupstrata";

function fixture(base: ConfigData) {
  const config = structuredClone(base);
  const root = path.resolve("Strata");
  config.strataInstallations = [{ id: "setup-test", root, ownership: "external", registeredAt: new Date().toISOString() }];
  return { config, file: path.join(root, "strata-qwen.json") };
}

describe("Windows setup Strata profile", () => {
  let temp: string;
  let base: ConfigData;
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "setup-strata-"));
    vi.stubEnv("XDG_CONFIG_HOME", temp);
    vi.resetModules();
    base = structuredClone(await (await import("../config")).loadConfig());
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.remove(temp);
  });
  it("creates conservative local settings without changing the active profile", () => {
    const { config, file } = fixture(base);
    const active = config.server.activeProfile;
    expect(addSetupStrataProfile(config, "setup-test", file, 32768)).toBe(true);
    expect(config.server.activeProfile).toBe(active);
    expect(config.server.profiles.strata.presets.server).toMatchObject({ host: "127.0.0.1", port: 1234, apiKey: null });
    expect(config.server.profiles.strata.strata).toMatchObject({
      installationId: "setup-test", configPath: file,
      overrides: { maxContext: 32768, parallel: 1, batchMtp: "off" },
    });
    expect(config.server.profiles.strata.strata?.overrides).not.toHaveProperty("kvStreaming");
  });

  it("leaves an existing profile unchanged on rerun", () => {
    const { config, file } = fixture(base);
    config.server.profiles.strata = structuredClone(config.server.profiles.Default);
    const before = structuredClone(config);
    expect(addSetupStrataProfile(config, "setup-test", file, 32768)).toBe(false);
    expect(config).toEqual(before);
  });

  it("rejects a missing registration, outside config and excessive context before mutation", () => {
    const { config, file } = fixture(base);
    expect(() => addSetupStrataProfile(config, "missing", file, 32768)).toThrow("not registered");
    expect(() => addSetupStrataProfile(config, "setup-test", path.resolve("outside.json"), 32768)).toThrow("inside");
    expect(() => addSetupStrataProfile(config, "setup-test", file, 262144)).toThrow("context");
    expect(config.server.profiles.strata).toBeUndefined();
  });

  it("does not rewrite config when the CLI finds an existing strata profile", async () => {
    const { config, file } = fixture(base);
    addSetupStrataProfile(config, "setup-test", file, 32768);
    const configFile = path.join(temp, "config.json");
    await fs.writeJson(configFile, config, { spaces: 2 });
    const before = await fs.readFile(configFile, "utf8");
    const output = execFileSync(process.execPath, ["--import", "tsx",
      path.resolve("scripts", "register-setup-strata.ts"), path.dirname(file), "32768"],
    { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: temp } });
    expect(output).toContain("already exists");
    expect(await fs.readFile(configFile, "utf8")).toBe(before);
    expect(await fs.readdir(temp)).toEqual(["config.json"]);
  });

  it("refuses to overwrite malformed config from the CLI", async () => {
    const configFile = path.join(temp, "config.json");
    await fs.writeFile(configFile, "{broken");
    expect(() => execFileSync(process.execPath, ["--import", "tsx",
      path.resolve("scripts", "register-setup-strata.ts"), temp, "32768"],
    { encoding: "utf8", stdio: "pipe", env: { ...process.env, XDG_CONFIG_HOME: temp } })).toThrow();
    expect(await fs.readFile(configFile, "utf8")).toBe("{broken");
  });
});

describe.skipIf(process.platform !== "win32")("Windows setup choices", () => {
  it("validates winget bootstrap, update rerun/divergence and NVIDIA failure guidance", () => {
    const script = path.resolve("scripts", "setup-windows.ps1").replaceAll("'", "''");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      . '${script}'
      $script:repaired = $false
      function Get-Command { param($Name) if ($Name -eq 'winget.exe' -and $script:repaired) { 'winget' } }
      function Install-PackageProvider {}
      function Install-Module {}
      function Import-Module {}
      function Repair-WinGetPackageManager { $script:repaired = $true }
      function Update-SetupPath {}
      function Invoke-Checked { param($Command, $Arguments) }
      Ensure-SetupWinget Install $true
      if (-not $script:repaired) { throw 'No repair' }
      'bootstrap verified'
      function Test-Path { $true }
      $script:counts = '0 2'
      function git.exe {
        $global:LASTEXITCODE = 0
        switch ($args[2]) {
          'rev-parse' { 'origin/test' }
          'rev-list' { $script:counts }
          'status' { }
          default { throw "Unexpected git $args" }
        }
      }
      try { Update-SetupClone test Install $true; throw 'No rerun' }
      catch { if ($_.Exception.Message -notmatch 'Rerun setup') { throw }; 'rerun required' }
      $script:counts = '1 2'
      try { Update-SetupClone test Install $true; throw 'No divergence guard' }
      catch { if ($_.Exception.Message -notmatch 'diverged') { throw }; 'divergence blocked' }
      function Get-CimInstance { [pscustomobject]@{Name='NVIDIA RTX'} }
      function Test-Path { $false }
      try { Test-SetupNvidia cuda; throw 'No driver guidance' }
      catch { if ($_.Exception.Message -notmatch 'nvidia.com/drivers') { throw }; 'driver guidance supplied' }
    `], { encoding: "utf8" });
    expect(output).toContain("bootstrap verified");
    expect(output).toContain("rerun required");
    expect(output).toContain("divergence blocked");
    expect(output).toContain("driver guidance supplied");
  });

  it("protects update consent and dirty worktrees, handles missing winget and AMD, and prints conditional guidance", () => {
    const script = path.resolve("scripts", "setup-windows.ps1").replaceAll("'", "''");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      . '${script}'
      function Read-Host { throw 'Unexpected prompt' }
      function Get-Command { param($Name) if ($Name -ne 'winget.exe') { throw "Unexpected lookup $Name" } }
      try { Ensure-SetupWinget Ask $true; throw 'Missing winget ignored' }
      catch { if ($_.Exception.Message -notmatch 'App Installer') { throw }; 'winget declined safely' }
      function Get-CimInstance { [pscustomobject]@{Name='AMD Radeon'} }
      Test-SetupNvidia auto
      function Test-Path { $true }
      function git.exe {
        $global:LASTEXITCODE = 0
        switch ($args[2]) {
          'rev-parse' { 'origin/test' }
          'rev-list' { '0 2' }
          'status' { '?? local.txt' }
          default { throw "Unexpected git $args" }
        }
      }
      function Invoke-Checked {
        param($Command, $Arguments)
        if ($Arguments -contains 'pull') { throw 'Unsafe pull' }
      }
      Update-SetupClone 'test' Ask $true
      try { Update-SetupClone 'test' Install $true; throw 'Dirty update ignored' }
      catch { if ($_.Exception.Message -notmatch 'not clean') { throw }; 'dirty update blocked' }
      Write-SetupNextSteps $true
      Write-SetupNextSteps $false
    `], { encoding: "utf8" });
    expect(output).toContain("winget declined safely");
    expect(output).toContain("No NVIDIA adapter");
    expect(output).toContain("incoming updates were not applied");
    expect(output).toContain("dirty update blocked");
    expect(output).toContain("select strata");
    expect(output).toContain("Q4_K_M");
  });

  it("stops when a prerequisite command fails", () => {
    const script = path.resolve("scripts", "setup-windows.ps1").replaceAll("'", "''");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      . '${script}'
      try {
        Invoke-Checked 'powershell.exe' @('-NoProfile', '-Command', 'exit 7')
        throw 'Failure was ignored'
      } catch {
        if ($_.Exception.Message -notmatch 'failed \\(exit 7\\)') { throw }
        'Failure propagated'
      }
    `], { encoding: "utf8" });
    expect(output.trim()).toBe("Failure propagated");
  });

  it("never prompts unattended and only installs explicitly selected optional components", () => {
    const script = path.resolve("scripts", "setup-windows.ps1").replaceAll("'", "''");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      . '${script}'
      function Read-Host { throw 'Unexpected prompt' }
      $choices = @(
        (Confirm-SetupChoice Ask 'test' $true),
        (Confirm-SetupChoice Install 'test' $true),
        (Confirm-SetupChoice Skip 'test' $false)
      )
      $choices -join ','
    `], { encoding: "utf8" });
    expect(output.trim()).toBe("False,True,False");
  });

  it("defaults interactive answers to no and retries invalid input", () => {
    const script = path.resolve("scripts", "setup-windows.ps1").replaceAll("'", "''");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      . '${script}'
      $script:answers = [Collections.Generic.Queue[string]]::new()
      $script:answers.Enqueue('')
      $script:answers.Enqueue('invalid')
      $script:answers.Enqueue('yes')
      function Read-Host { $script:answers.Dequeue() }
      Confirm-SetupChoice Ask 'test' $false
      Confirm-SetupChoice Ask 'test' $false
    `], { encoding: "utf8" });
    expect(output).toContain("False");
    expect(output).toContain("Enter yes or no.");
    expect(output).toContain("True");
  });
});
