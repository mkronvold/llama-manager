import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { getVersionsDir } from "./config";
import type { ConfigData } from "./config";

export type GpuTelemetryMode = "auto" | "windows" | "vendor" | "vulkan" | "disabled";

export interface GpuTelemetrySettings {
  mode: GpuTelemetryMode;
  nvidiaSmiPath: string | null;
  amdSmiPath: string | null;
  allowAmdSmiWindows: boolean;
}

export interface GpuTelemetrySourceSnapshot {
  id: string;
  label: string;
  gpus: GpuSnapshot[];
  error: string | null;
}

export interface GpuSnapshot {
  label: string;
  source: string;
  /** 0-100, or null if utilization couldn't be determined for this adapter. */
  utilizationPercent: number | null;
  dedicatedUsedBytes: number | null;
  dedicatedTotalBytes: number | null;
  sharedUsedBytes: number | null;
  sharedTotalBytes: number | null;
}

export interface SystemSnapshot {
  cpuPercent: number | null;
  ramUsedBytes: number;
  ramTotalBytes: number;
  gpuSources: GpuTelemetrySourceSnapshot[];
  gpus: GpuSnapshot[];
  /** Set when GPU stats couldn't be collected at all (e.g. no source available). */
  gpuError: string | null;
}

export const DEFAULT_GPU_TELEMETRY: GpuTelemetrySettings = {
  mode: "auto",
  nvidiaSmiPath: null,
  amdSmiPath: null,
  allowAmdSmiWindows: false,
};

/**
 * Samples CPU utilization by taking two os.cpus() readings `sampleMs` apart and
 * computing the delta of busy vs. idle ticks across all cores. A single
 * instantaneous os.cpus() reading only gives cumulative totals since boot, which
 * is not useful for a "current utilization" gauge.
 */
export function sampleCpuPercent(sampleMs = 200): Promise<number | null> {
  const readTotals = () => {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    return { idle, total };
  };

  const start = readTotals();
  return new Promise((resolve) => {
    setTimeout(() => {
      const end = readTotals();
      const idleDelta = end.idle - start.idle;
      const totalDelta = end.total - start.total;
      if (totalDelta <= 0) {
        resolve(null);
        return;
      }
      const percent = (1 - idleDelta / totalDelta) * 100;
      resolve(Math.max(0, Math.min(100, percent)));
    }, sampleMs);
  });
}

export function getMemoryInfo(): { usedBytes: number; totalBytes: number } {
  const totalBytes = os.totalmem();
  const usedBytes = totalBytes - os.freemem();
  return { usedBytes, totalBytes };
}

function telemetrySettings(config?: ConfigData | null): GpuTelemetrySettings {
  return {
    ...DEFAULT_GPU_TELEMETRY,
    ...(config?.gpuTelemetry || {}),
  };
}

function runCommand(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawn(cmd, args, { windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.stderr?.on("data", (d) => { err += d.toString(); });
      child.on("error", () => { clearTimeout(timer); finish(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? out : null);
      });
    } catch {
      finish(null);
    }
  });
}

function isExecutableFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveExecutable(command: string, overridePath: string | null | undefined, extraCandidates: string[] = []): string | null {
  if (overridePath?.trim()) {
    return isExecutableFile(overridePath.trim()) ? overridePath.trim() : null;
  }

  const candidates = [...extraCandidates];
  const pathExts = os.platform() === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of pathExts) {
      candidates.push(path.join(dir.replace(/^"|"$/g, ""), command.endsWith(ext.toLowerCase()) || command.endsWith(ext) ? command : `${command}${ext.toLowerCase()}`));
    }
  }

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }

  return null;
}

function resolveNvidiaSmi(overridePath?: string | null): string | null {
  const candidates: string[] = [];
  if (os.platform() === "win32") {
    const programFiles = process.env.ProgramFiles;
    const systemRoot = process.env.SystemRoot;
    if (programFiles) candidates.push(path.join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
    if (systemRoot) candidates.push(path.join(systemRoot, "System32", "nvidia-smi.exe"));
  }
  return resolveExecutable(os.platform() === "win32" ? "nvidia-smi.exe" : "nvidia-smi", overridePath, candidates);
}

function resolveAmdSmi(overridePath?: string | null): string | null {
  return resolveExecutable(os.platform() === "win32" ? "amd-smi.exe" : "amd-smi", overridePath);
}

function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const value = raw.trim();
  if (!value || value === "[N/A]" || value.toLowerCase() === "n/a") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mbToBytes(mb: number | null): number | null {
  return mb === null ? null : Math.round(mb * 1024 * 1024);
}

function bytesToSnapshotBytes(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses the CSV output of Get-Counter samples formatted as
 * "InstanceName,CookedValue" (one per line, no header) into a map keyed by the
 * adapter LUID substring shared between the "GPU Engine" and "GPU Adapter
 * Memory" counter sets (e.g. "luid_0x00000000_0x000158d5_phys_0").
 */
export function sumByLuid(lines: string[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const idx = line.lastIndexOf(",");
    if (idx === -1) continue;
    const instance = line.slice(0, idx).trim();
    const value = parseFloat(line.slice(idx + 1).trim());
    if (!Number.isFinite(value)) continue;
    const match = instance.match(/luid_0x[0-9a-f]+_0x[0-9a-f]+_phys_\d+/i);
    const key = match ? match[0].toLowerCase() : instance.toLowerCase();
    totals.set(key, (totals.get(key) || 0) + value);
  }
  return totals;
}

export interface DxgiAdapterBudget {
  luidKey: string;
  name: string;
  isSoftware: boolean;
  localBudgetBytes: number | null;
  nonLocalBudgetBytes: number | null;
}

// On some systems (observed on an AMD Strix Halo/APU with unified memory)
// the "GPU Adapter Memory" performance counter set only registers the
// Dedicated/Shared *Usage* counters and never registers the *Usage Limit*
// counters, so the OS never reports an adapter capacity through Get-Counter.
// DXGI's IDXGIAdapter3::QueryVideoMemoryInfo exposes an OS-negotiated
// "Budget" per memory segment group (local/non-local) that is available even
// when the classic perf counters are missing a limit, so it is used here as
// a capacity fallback. Note DXGI's CurrentUsage field is scoped to the
// calling process (per Microsoft's docs) and is NOT a system-wide usage
// figure, so it is intentionally not used for "used" values - only Budget.
async function getDxgiAdapterBudgets(): Promise<Map<string, DxgiAdapterBudget>> {
  const result = new Map<string, DxgiAdapterBudget>();
  if (os.platform() !== "win32") return result;

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DXGI_ADAPTER_DESC1
{
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId; public uint DeviceId; public uint SubSysId; public uint Revision;
    public UIntPtr DedicatedVideoMemory; public UIntPtr DedicatedSystemMemory; public UIntPtr SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
}

[StructLayout(LayoutKind.Sequential)]
public struct DXGI_QUERY_VIDEO_MEMORY_INFO { public ulong Budget; public ulong CurrentUsage; public ulong AvailableForReservation; public ulong CurrentReservation; }

public static class LmDxgi
{
    [DllImport("dxgi.dll")]
    public static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);

    public delegate int EnumAdapters1Delegate(IntPtr self, uint index, out IntPtr adapter);
    public static int EnumAdapters1(IntPtr factory, uint index, out IntPtr adapter)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(factory);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, 12 * IntPtr.Size);
        var del = (EnumAdapters1Delegate)Marshal.GetDelegateForFunctionPointer(fn, typeof(EnumAdapters1Delegate));
        return del(factory, index, out adapter);
    }

    public delegate void GetDesc1Delegate(IntPtr self, out DXGI_ADAPTER_DESC1 desc);
    public static void GetDesc1(IntPtr adapter1, out DXGI_ADAPTER_DESC1 desc)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(adapter1);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, 10 * IntPtr.Size);
        var del = (GetDesc1Delegate)Marshal.GetDelegateForFunctionPointer(fn, typeof(GetDesc1Delegate));
        del(adapter1, out desc);
    }

    public delegate int QIDelegate(IntPtr self, ref Guid iid, out IntPtr result);
    public static int QueryInterface(IntPtr obj, ref Guid iid, out IntPtr result)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(obj);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, 0);
        var del = (QIDelegate)Marshal.GetDelegateForFunctionPointer(fn, typeof(QIDelegate));
        return del(obj, ref iid, out result);
    }

    public delegate int QVMIDelegate(IntPtr self, uint node, uint group, out DXGI_QUERY_VIDEO_MEMORY_INFO info);
    public static int QueryVideoMemoryInfo(IntPtr adapter3, uint node, uint group, out DXGI_QUERY_VIDEO_MEMORY_INFO info)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(adapter3);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, 14 * IntPtr.Size);
        var del = (QVMIDelegate)Marshal.GetDelegateForFunctionPointer(fn, typeof(QVMIDelegate));
        return del(adapter3, node, group, out info);
    }
}
"@
$iidFactory1 = [Guid]"7b7166ec-21c7-44ae-b21a-c9ae321ae369"
$iidAdapter3 = [Guid]"645967A4-1392-4310-A798-8053CE3E93FD"
$factory = [IntPtr]::Zero
$hr = [LmDxgi]::CreateDXGIFactory1([ref]$iidFactory1, [ref]$factory)
if ($hr -ne 0) { exit 0 }
$i = 0
while ($true) {
  $adapter1 = [IntPtr]::Zero
  $hr = [LmDxgi]::EnumAdapters1($factory, [uint32]$i, [ref]$adapter1)
  if ($hr -ne 0) { break }
  $desc = New-Object DXGI_ADAPTER_DESC1
  [LmDxgi]::GetDesc1($adapter1, [ref]$desc)
  $luid = "luid_0x$($desc.LuidHigh.ToString('x8'))_0x$($desc.LuidLow.ToString('x8'))_phys_0"
  $adapter3 = [IntPtr]::Zero
  $hrqi = [LmDxgi]::QueryInterface($adapter1, [ref]$iidAdapter3, [ref]$adapter3)
  $localBudget = -1
  $nonLocalBudget = -1
  if ($hrqi -eq 0) {
    $local = New-Object DXGI_QUERY_VIDEO_MEMORY_INFO
    $nonlocal = New-Object DXGI_QUERY_VIDEO_MEMORY_INFO
    if ([LmDxgi]::QueryVideoMemoryInfo($adapter3, 0, 0, [ref]$local) -eq 0) { $localBudget = $local.Budget }
    if ([LmDxgi]::QueryVideoMemoryInfo($adapter3, 0, 1, [ref]$nonlocal) -eq 0) { $nonLocalBudget = $nonlocal.Budget }
  }
  "$luid,$($desc.Description),$($desc.Flags),$localBudget,$nonLocalBudget"
  $i++
}
`;

  const output = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 5000);
  if (!output) return result;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const luidKey = parts[0]!.toLowerCase();
    const name = parts[1]!.trim();
    const flags = Number(parts[2]);
    const localBudget = Number(parts[3]);
    const nonLocalBudget = Number(parts[4]);
    const existing = result.get(luidKey);
    const localBudgetBytes = Number.isFinite(localBudget) && localBudget >= 0 ? localBudget : null;
    const nonLocalBudgetBytes = Number.isFinite(nonLocalBudget) && nonLocalBudget >= 0 ? nonLocalBudget : null;
    // Multiple DXGI adapter objects can share the same LUID (hybrid/compute
    // nodes for one physical GPU); keep the entry with the largest budget.
    if (existing && (existing.localBudgetBytes || 0) >= (localBudgetBytes || 0)) continue;
    result.set(luidKey, {
      luidKey,
      name,
      isSoftware: (flags & 0x2) !== 0,
      localBudgetBytes,
      nonLocalBudgetBytes,
    });
  }

  return result;
}

// Resolves an adapter's memory capacity, preferring the perf-counter Limit
// value when present and otherwise falling back to a DXGI Budget figure
// (never used for software/basic-render adapters).
export function resolveAdapterTotalBytes(
  limitBytes: number | null | undefined,
  dxgi: DxgiAdapterBudget | undefined,
  segment: "local" | "nonLocal",
): number | null {
  if (limitBytes !== undefined && limitBytes !== null) return limitBytes;
  if (!dxgi || dxgi.isSoftware) return null;
  const budget = segment === "local" ? dxgi.localBudgetBytes : dxgi.nonLocalBudgetBytes;
  return budget && budget > 0 ? budget : null;
}

async function getWindowsCounterGpuSnapshots(): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  if (os.platform() !== "win32") {
    return { gpus: [], error: "Windows performance counters are only available on Windows" };
  }

  // A single powershell invocation gathers all four counter sets to avoid
  // paying process-spawn overhead four times per refresh. Errors from any
  // individual Get-Counter call are swallowed so one missing counter set
  // doesn't blank out the others.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
function Emit($counterPath) {
  $samples = (Get-Counter $counterPath -ErrorAction SilentlyContinue).CounterSamples
  foreach ($s in $samples) { "$($s.InstanceName),$($s.CookedValue)" }
}
"---UTIL---"
Emit '\\GPU Engine(*)\\Utilization Percentage'
"---DEDICATED_USED---"
Emit '\\GPU Adapter Memory(*)\\Dedicated Usage'
"---DEDICATED_LIMIT---"
Emit '\\GPU Adapter Memory(*)\\Dedicated Usage Limit'
"---SHARED_USED---"
Emit '\\GPU Adapter Memory(*)\\Shared Usage'
"---SHARED_LIMIT---"
Emit '\\GPU Adapter Memory(*)\\Shared Usage Limit'
`;

  const queryOnce = async (): Promise<{ gpus: GpuSnapshot[]; error: string | null }> => {
    const [output, dxgiBudgets] = await Promise.all([
      runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 5000),
      getDxgiAdapterBudgets(),
    ]);
    if (!output) {
      return { gpus: [], error: "Windows counters: could not read GPU performance counters" };
    }

    const sections: Record<string, string[]> = {
      UTIL: [], DEDICATED_USED: [], DEDICATED_LIMIT: [], SHARED_USED: [], SHARED_LIMIT: [],
    };
    let current: string | null = null;
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const header = line.match(/^---(\w+)---$/);
      if (header) {
        current = header[1]!;
        continue;
      }
      if (current && sections[current]) sections[current].push(line);
    }

    const utilByLuid = sumByLuid(sections.UTIL!);
    const dedicatedUsedByLuid = sumByLuid(sections.DEDICATED_USED!);
    const dedicatedLimitByLuid = sumByLuid(sections.DEDICATED_LIMIT!);
    const sharedUsedByLuid = sumByLuid(sections.SHARED_USED!);
    const sharedLimitByLuid = sumByLuid(sections.SHARED_LIMIT!);

    // Some drivers (observed with unified-memory AMD APUs) only register the
    // Usage counters and never register the Usage Limit counters, so adapter
    // detection must not require a Limit counter to be present.
    const adapterKeys = new Set<string>([
      ...utilByLuid.keys(),
      ...dedicatedUsedByLuid.keys(),
      ...dedicatedLimitByLuid.keys(),
      ...sharedUsedByLuid.keys(),
      ...sharedLimitByLuid.keys(),
    ]);
    if (adapterKeys.size === 0) {
      return { gpus: [], error: "Windows counters: no GPU adapters reported" };
    }

    const gpus: GpuSnapshot[] = Array.from(adapterKeys).map((key, i) => {
      const dxgi = dxgiBudgets.get(key);
      const dedicatedTotalBytes = resolveAdapterTotalBytes(dedicatedLimitByLuid.get(key), dxgi, "local");
      const sharedTotalBytes = resolveAdapterTotalBytes(sharedLimitByLuid.get(key), dxgi, "nonLocal");
      return {
        label: `GPU ${i + 1}`,
        source: "Windows counters",
        utilizationPercent: utilByLuid.has(key) ? Math.min(100, utilByLuid.get(key)!) : null,
        dedicatedUsedBytes: dedicatedUsedByLuid.get(key) ?? null,
        dedicatedTotalBytes,
        sharedUsedBytes: sharedUsedByLuid.get(key) ?? null,
        sharedTotalBytes,
      };
    });

    gpus.sort((a, b) => (b.dedicatedTotalBytes || 0) - (a.dedicatedTotalBytes || 0));
    gpus.forEach((g, i) => { g.label = `GPU ${i + 1}`; });

    return { gpus, error: null };
  };

  const first = await queryOnce();
  if (first.gpus.length > 0) return first;

  // Get-Counter can transiently return zero samples for a counter set even
  // though the counters are registered and working (observed intermittently
  // on this machine, likely a perf-counter provider hiccup). Retrying once
  // after a short delay avoids the System tab's displayed GPU set flapping
  // between "Windows counters" (N GPUs) and a fallback source on every other
  // 2s poll when the counters are actually fine.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const retry = await queryOnce();
  return retry.gpus.length > 0 ? retry : first;
}

export function parseNvidiaSmiCsv(output: string): GpuSnapshot[] {
  const gpus: GpuSnapshot[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 5) continue;

    const index = parseNumber(parts[0]);
    const totalMb = parseNumber(parts[parts.length - 1]);
    const usedMb = parseNumber(parts[parts.length - 2]);
    const util = parseNumber(parts[parts.length - 3]);
    const name = parts.slice(1, parts.length - 3).join(", ").trim();

    gpus.push({
      label: name || `GPU ${index !== null ? index + 1 : gpus.length + 1}`,
      source: "nvidia-smi",
      utilizationPercent: util === null ? null : Math.max(0, Math.min(100, util)),
      dedicatedUsedBytes: mbToBytes(usedMb),
      dedicatedTotalBytes: mbToBytes(totalMb),
      sharedUsedBytes: null,
      sharedTotalBytes: null,
    });
  }
  return gpus;
}

async function getNvidiaSmiGpuSnapshots(settings: GpuTelemetrySettings): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  const exe = resolveNvidiaSmi(settings.nvidiaSmiPath);
  if (!exe) return { gpus: [], error: "nvidia-smi: not found (managed by NVIDIA driver installation)" };

  const output = await runCommand(exe, [
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ], 5000);
  if (!output) return { gpus: [], error: "nvidia-smi: query failed or timed out" };

  const gpus = parseNvidiaSmiCsv(output);
  return gpus.length > 0 ? { gpus, error: null } : { gpus: [], error: "nvidia-smi: no GPU rows returned" };
}

function hipSdkDetected(): boolean {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).map((p) => p.replace(/^"|"$/g, ""));
  const hipInfoNames = os.platform() === "win32" ? ["hipinfo.exe", "hipInfo.exe"] : ["hipinfo", "hipInfo"];
  for (const dir of pathEntries) {
    for (const name of hipInfoNames) {
      if (isExecutableFile(path.join(dir, name))) return true;
    }
  }
  for (const envVar of ["HIP_PATH", "HIP_PATH_57", "ROCM_PATH"]) {
    const root = process.env[envVar];
    if (!root) continue;
    for (const name of hipInfoNames) {
      if (isExecutableFile(path.join(root, "bin", name))) return true;
    }
  }
  return false;
}

function parseAmdMemoryMb(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = parseFloat(value.replace(/,/g, ""));
    if (!Number.isFinite(parsed)) return null;
    const lower = value.toLowerCase();
    if (lower.includes("gib") || lower.includes("gb")) return parsed * 1024;
    if (lower.includes("kib") || lower.includes("kb")) return parsed / 1024;
    return parsed;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const raw = obj.value ?? obj.val ?? obj.current;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
    if (!Number.isFinite(parsed)) return null;
    const unit = String(obj.unit ?? "").toLowerCase();
    if (unit.includes("gib") || unit === "gb" || unit === "g") return parsed * 1024;
    if (unit.includes("kib") || unit === "kb" || unit === "k") return parsed / 1024;
    return parsed;
  }
  return null;
}

function parseAmdNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseNumber(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return parseAmdNumber(obj.value ?? obj.val ?? obj.current);
  }
  return null;
}

function amdGpuEntries(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  for (const key of ["gpu_data", "gpus", "gpu"]) {
    if (Array.isArray(obj[key])) {
      return obj[key].filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
    }
  }
  return [obj];
}

export function parseAmdSmiJson(output: string): GpuSnapshot[] {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return [];
  }

  const gpus: GpuSnapshot[] = [];
  for (const gpuData of amdGpuEntries(data)) {
    const usage = gpuData.usage ?? gpuData.gpu_activity;
    const gpuUtil = typeof usage === "object" && usage !== null
      ? parseAmdNumber((usage as Record<string, unknown>).gfx_activity ?? (usage as Record<string, unknown>).gpu_use_percent)
      : parseAmdNumber(usage);

    const vramData = (gpuData.mem_usage ?? gpuData.vram ?? gpuData.fb_memory_usage) as Record<string, unknown> | undefined;
    const usedMb = vramData && typeof vramData === "object"
      ? parseAmdMemoryMb(vramData.used_vram ?? vramData.vram_used ?? vramData.used)
      : null;
    const totalMb = vramData && typeof vramData === "object"
      ? parseAmdMemoryMb(vramData.total_vram ?? vramData.vram_total ?? vramData.total)
      : null;

    const name = String(gpuData.name ?? gpuData.market_name ?? gpuData.product_name ?? `AMD GPU ${gpus.length + 1}`);
    gpus.push({
      label: name,
      source: "amd-smi",
      utilizationPercent: gpuUtil === null ? null : Math.max(0, Math.min(100, gpuUtil)),
      dedicatedUsedBytes: mbToBytes(usedMb),
      dedicatedTotalBytes: mbToBytes(totalMb),
      sharedUsedBytes: null,
      sharedTotalBytes: null,
    });
  }
  return gpus;
}

async function getAmdSmiGpuSnapshots(settings: GpuTelemetrySettings): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  if (os.platform() === "win32" && !settings.allowAmdSmiWindows && !hipSdkDetected()) {
    return { gpus: [], error: "amd-smi: disabled on Windows until HIP SDK is detected or AMD SMI is explicitly enabled" };
  }

  const exe = resolveAmdSmi(settings.amdSmiPath);
  if (!exe) return { gpus: [], error: "amd-smi: not found (install/update AMD HIP/ROCm SDK tooling separately; drivers are not managed here)" };

  const output = await runCommand(exe, ["metric", "--json"], os.platform() === "win32" ? 30000 : 10000);
  if (!output) return { gpus: [], error: "amd-smi: query failed or timed out" };

  const gpus = parseAmdSmiJson(output);
  return gpus.length > 0 ? { gpus, error: null } : { gpus: [], error: "amd-smi: no usable GPU rows returned" };
}

function findFileRecursive(root: string, fileName: string, maxDepth = 3): string | null {
  const target = fileName.toLowerCase();
  const visit = (dir: string, depth: number): string | null => {
    if (depth > maxDepth) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) return fullPath;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = visit(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(root, 0);
}

export function parseVulkanProbeOutput(output: string): GpuSnapshot[] {
  const gpus: GpuSnapshot[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const index = Number(parts[0]);
    const freeBytes = bytesToSnapshotBytes(parts[1]!);
    const totalBytes = bytesToSnapshotBytes(parts[2]!);
    if (!Number.isFinite(index) || freeBytes === null || totalBytes === null || totalBytes <= 0) continue;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    gpus.push({
      label: `Vulkan GPU ${index + 1}`,
      source: "Vulkan (ggml)",
      utilizationPercent: null,
      dedicatedUsedBytes: usedBytes,
      dedicatedTotalBytes: totalBytes,
      sharedUsedBytes: null,
      sharedTotalBytes: null,
    });
  }
  return gpus;
}

async function getVulkanGpuSnapshots(config?: ConfigData | null): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  if (os.platform() !== "win32") {
    return { gpus: [], error: "Vulkan: ggml runtime probing is currently implemented for Windows runtimes only" };
  }
  if (!config?.activeVersion) {
    return { gpus: [], error: "Vulkan: no active runtime selected" };
  }

  const versionPath = path.join(getVersionsDir(config), config.activeVersion);
  const baseDll = findFileRecursive(versionPath, "ggml-base.dll");
  const vulkanDll = findFileRecursive(versionPath, "ggml-vulkan.dll");
  if (!baseDll || !vulkanDll) {
    return { gpus: [], error: "Vulkan: active runtime does not include ggml-vulkan.dll" };
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool SetDllDirectory(string lpPathName);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr LoadLibrary(string lpFileName);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  public delegate int CountDelegate();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  public delegate void MemoryDelegate(int device, out UIntPtr free, out UIntPtr total);
}
"@
$dir = ${JSON.stringify(path.dirname(vulkanDll))}
[Native]::SetDllDirectory($dir) | Out-Null
$base = [Native]::LoadLibrary(${JSON.stringify(baseDll)})
$vk = [Native]::LoadLibrary(${JSON.stringify(vulkanDll)})
if ($base -eq [IntPtr]::Zero -or $vk -eq [IntPtr]::Zero) { throw "Could not load ggml Vulkan libraries" }
$countPtr = [Native]::GetProcAddress($vk, "ggml_backend_vk_get_device_count")
$memoryPtr = [Native]::GetProcAddress($vk, "ggml_backend_vk_get_device_memory")
if ($countPtr -eq [IntPtr]::Zero -or $memoryPtr -eq [IntPtr]::Zero) { throw "Required ggml Vulkan exports not found" }
$countFn = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($countPtr, [Native+CountDelegate])
$memoryFn = [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($memoryPtr, [Native+MemoryDelegate])
$count = $countFn.Invoke()
for ($i = 0; $i -lt $count; $i++) {
  $free = [UIntPtr]::Zero
  $total = [UIntPtr]::Zero
  $memoryFn.Invoke($i, [ref]$free, [ref]$total)
  "$i,$($free.ToUInt64()),$($total.ToUInt64())"
}
`;

  const output = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 5000);
  if (!output) return { gpus: [], error: "Vulkan: ggml Vulkan memory probe failed" };
  const gpus = parseVulkanProbeOutput(output);
  return gpus.length > 0 ? { gpus, error: null } : { gpus: [], error: "Vulkan: no devices reported by ggml Vulkan backend" };
}

function sourceResult(id: string, label: string, result: { gpus: GpuSnapshot[]; error: string | null }): GpuTelemetrySourceSnapshot {
  return { id, label, gpus: result.gpus, error: result.error };
}

/**
 * Collects per-adapter GPU utilization and VRAM using the configured source
 * cascade. In auto mode:
 *  1. Windows performance counters
 *  2. NVIDIA nvidia-smi
 *  3. AMD amd-smi (gated on Windows)
 *  4. Vulkan ggml runtime memory probe
 */
export async function getGpuTelemetrySources(config?: ConfigData | null): Promise<GpuTelemetrySourceSnapshot[]> {
  const settings = telemetrySettings(config);
  if (settings.mode === "disabled") {
    return [sourceResult("disabled", "Disabled", { gpus: [], error: "GPU telemetry is disabled in Options" })];
  }

  const sources: GpuTelemetrySourceSnapshot[] = [];

  if (settings.mode === "auto" || settings.mode === "windows") {
    sources.push(sourceResult("windows", "Windows counters", await getWindowsCounterGpuSnapshots()));
  }

  if (settings.mode === "auto" || settings.mode === "vendor") {
    sources.push(sourceResult("nvidia", "nvidia-smi", await getNvidiaSmiGpuSnapshots(settings)));
    sources.push(sourceResult("amd", "amd-smi", await getAmdSmiGpuSnapshots(settings)));
  }

  if (settings.mode === "auto" || settings.mode === "vulkan") {
    sources.push(sourceResult("vulkan", "Vulkan (ggml)", await getVulkanGpuSnapshots(config)));
  }

  return sources.length > 0 ? sources : [sourceResult("none", "None", { gpus: [], error: "No GPU telemetry sources available" })];
}

export async function getGpuSnapshots(config?: ConfigData | null): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  const sources = await getGpuTelemetrySources(config);
  const firstAvailable = sources.find((source) => source.gpus.length > 0);
  if (firstAvailable) return { gpus: firstAvailable.gpus, error: null };
  return {
    gpus: [],
    error: sources.map((source) => source.error).filter(Boolean).join(" | ") || "No GPU telemetry sources available",
  };
}

export async function getSystemSnapshot(config?: ConfigData | null): Promise<SystemSnapshot> {
  const [cpuPercent, gpuResult] = await Promise.all([
    sampleCpuPercent(),
    getGpuTelemetrySources(config),
  ]);
  const { usedBytes, totalBytes } = getMemoryInfo();
  const firstAvailable = gpuResult.find((source) => source.gpus.length > 0);

  return {
    cpuPercent,
    ramUsedBytes: usedBytes,
    ramTotalBytes: totalBytes,
    gpuSources: gpuResult,
    gpus: firstAvailable?.gpus || [],
    gpuError: firstAvailable ? null : gpuResult.map((source) => source.error).filter(Boolean).join(" | "),
  };
}
