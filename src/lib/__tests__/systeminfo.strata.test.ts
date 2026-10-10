import { describe, expect, it } from "vitest";
import { buildNativeResidency, buildWindowsCounterScript } from "../systeminfo";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { parseProcessSnapshot, type ProcessRecord } from "../strataservice";

const date = "2026-10-10T00:00:00.000Z";
const target = { pid: 10, createdAt: date, executable: "C:\\strata\\python.exe", engineExecutable: "C:\\strata\\strata.exe" };
const records: ProcessRecord[] = [
  { pid: 10, ppid: 1, createdAt: date, executable: target.executable, name: "python.exe" },
  { pid: 11, ppid: 10, createdAt: date, executable: target.executable, name: "python.exe" },
  { pid: 12, ppid: 11, createdAt: date, executable: target.engineExecutable, name: "strata.exe" },
  { pid: 13, ppid: 11, createdAt: date, executable: target.engineExecutable, name: "strata.exe" },
];
const proc = ["10|private,99999", "12|private,1000", "12|workingset,400", "13|private,2000", "13|workingset,500"];
const dedicated = ["pid_12_luid_0x0_0x1_phys_0,200", "pid_13_luid_0x0_0x1_phys_0,300", "pid_12_luid_0x0_0x1_phys_0,200"];
const shared = ["pid_12_luid_0x0_0x1_phys_0,100", "pid_13_luid_0x0_0x1_phys_0,100"];

describe("native Strata memory attribution", () => {
  it("sums verified native engines once, excluding the Python supervisor", () => {
    expect(buildNativeResidency(target, records, records, proc, dedicated, shared)).toEqual({
      pid: 12, pids: [12, 13], committedBytes: 3000, workingSetBytes: 900,
      dedicatedBytes: 500, sharedBytes: 200, elsewhereBytes: 2300,
    });
  });

  it("rejects reused supervisor and engine PIDs", () => {
    const reused = records.map((r) => r.pid === 12 ? { ...r, createdAt: "2026-10-11T00:00:00Z" } : r);
    expect(buildNativeResidency(target, records, reused, proc, dedicated, shared)).toBeNull();
    expect(buildNativeResidency({ ...target, createdAt: "2000-01-01T00:00:00Z" }, records, records, proc, dedicated, shared)).toBeNull();
    const unverifiedParent = records.map((r) => r.pid === 11 ? { ...r, createdAt: null } : r);
    expect(buildNativeResidency(target, unverifiedParent, unverifiedParent, proc, dedicated, shared)).toBeNull();
  });

  it("treats engine replacement/disappearance/missing counters as unavailable", () => {
    expect(buildNativeResidency(target, records, records.slice(0, 3), proc, dedicated, shared)).toBeNull();
    expect(buildNativeResidency(target, records, records, proc, dedicated, [])).toBeNull();
    expect(buildNativeResidency(target, records, records, [], dedicated, shared)).toBeNull();
    expect(buildNativeResidency(target, records.slice(0, 2), records.slice(0, 2), proc, dedicated, shared)).toBeNull();
  });

  it("does not attribute an unrelated engine or a same-PID different executable", () => {
    const unrelated = [...records, { pid: 14, ppid: 1, createdAt: date, executable: target.engineExecutable, name: "strata.exe" }];
    expect(buildNativeResidency(target, unrelated, unrelated, [...proc, "14|private,99999"], dedicated, shared)?.committedBytes).toBe(3000);
    const replaced = records.map((r) => r.pid === 12 ? { ...r, executable: "C:\\other.exe" } : r);
    expect(buildNativeResidency(target, records, replaced, proc, dedicated, shared)).toBeNull();
  });

  it.skipIf(os.platform() !== "win32")("generates valid PowerShell with safely quoted paths, without executing counters", () => {
    const script = buildWindowsCounterScript({ ...target, engineExecutable: "C:\\path with 'quotes'\\strata.exe" });
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const parser = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')),[ref]$null,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(parser, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(script).toContain("-split '\\|',5");
  });

  it.skipIf(os.platform() !== "win32")("executes native collection independently of the numeric llama PID branch", () => {
    const mocks = `
$ProgressPreference = 'SilentlyContinue'
function Get-CimInstance {
  foreach ($id in @(10,12)) {
    [pscustomobject]@{ ProcessId=$id; ParentProcessId=10; CreationDate=[datetime]'${date}';
      Name=$(if ($id -eq 10) { 'python.exe' } else { 'strata.exe' });
      ExecutablePath=$(if ($id -eq 10) { '${target.executable}' } else { '${target.engineExecutable}' }) }
  }
}
function Get-Process { param($Id) [pscustomobject]@{ PrivateMemorySize64=1000; WorkingSet64=400 } }
function Get-Counter { [pscustomobject]@{ CounterSamples=@() } }
`;
    const script = mocks + buildWindowsCounterScript(target);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const section = (name: string) => result.stdout.split(`---${name}---`)[1]!.split("---")[0]!.trim();
    expect(parseProcessSnapshot(section("SNAP_BEFORE"))).toHaveLength(2);
    expect(parseProcessSnapshot(section("SNAP_AFTER"))).toHaveLength(2);
    expect(section("PROC").split(/\r?\n/)).toEqual(["12|private,1000", "12|workingset,400"]);
    expect(buildNativeResidency(target, parseProcessSnapshot(section("SNAP_BEFORE")),
      parseProcessSnapshot(section("SNAP_AFTER")), section("PROC").split(/\r?\n/),
      ["pid_12_luid_0x0_0x1_phys_0,200"], ["pid_12_luid_0x0_0x1_phys_0,100"]))
      .toMatchObject({ pids: [12], committedBytes: 1000, workingSetBytes: 400 });
  });
});
