import { describe, expect, it } from "vitest";
import { buildNativeResidency, buildWindowsCounterScript } from "../systeminfo";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { ProcessRecord } from "../strataservice";

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
});
