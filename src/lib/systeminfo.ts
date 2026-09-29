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
  /**
   * Portion of ramUsedBytes that the GPU driver has locked as "shared" VRAM.
   * Shared VRAM is not extra memory - it is a window into the same system RAM,
   * so it must never be added to a systemwide total (which is exactly what
   * Task Manager's "GPU Memory" figure does).
   */
  sharedGpuRamBytes: number | null;
  /** RAM + dedicated VRAM carve-out, i.e. real installed memory. */
  systemwideUsedBytes: number | null;
  systemwideTotalBytes: number | null;
  /** Where the running server's committed memory actually landed. */
  residency: ProcessMemoryResidency | null;
  /** Commit charge and paging health. */
  pressure: MemoryPressure | null;
  gpuSources: GpuTelemetrySourceSnapshot[];
  gpus: GpuSnapshot[];
  /** Set when GPU stats couldn't be collected at all (e.g. no source available). */
  gpuError: string | null;
}

/**
 * Breakdown of where a process's committed memory physically resides. On a
 * unified-memory APU the model rarely fits in the VRAM carve-out alone, so this
 * answers "the model is N GB but dedicated+shared don't add up - where did the
 * rest go?".
 */
export interface ProcessMemoryResidency {
  pid: number;
  /** Private (committed) bytes: GPU allocations plus host-side KV cache/buffers. */
  committedBytes: number;
  /** Committed bytes resident in the dedicated VRAM carve-out. */
  dedicatedBytes: number;
  /** Committed bytes resident in system RAM via the GPU's shared aperture. */
  sharedBytes: number;
  /**
   * Derived remainder (committed - dedicated - shared): committed memory that
   * is not in GPU-visible memory, i.e. sitting in the compression store, the
   * pagefile, or plain host RAM. Derived rather than measured, because Windows
   * exposes no per-process split of those destinations.
   */
  elsewhereBytes: number;
  /** Resident set size, for reference. */
  workingSetBytes: number;
}

/**
 * Commit charge vs. limit, plus the paging rate. These answer two different
 * questions: available commit predicts whether the *next* model will load at
 * all, while the page-read rate is the only reliable signal that the *running*
 * model is actually being slowed by memory pressure.
 */
export interface MemoryPressure {
  committedBytes: number;
  commitLimitBytes: number;
  availableCommitBytes: number;
  /** Hard page reads/sec; near zero means evicted pages are cold, not hot. */
  pageReadsPerSec: number | null;
}

export const DEFAULT_GPU_TELEMETRY: GpuTelemetrySettings = {
  mode: "auto",
  nvidiaSmiPath: null,
  amdSmiPath: null,
  allowAmdSmiWindows: false,
};

interface CpuTotals {
  idle: number;
  total: number;
}

interface CpuSample extends CpuTotals {
  at: number;
}

// os.cpus() reports CPU time in milliseconds, but Windows only accumulates it
// on the scheduler tick (~15.6ms). Over a short window the per-core counts are
// therefore heavily quantized: measured on a 32-core APU under a steady ~55%
// load, 200ms windows returned values as far apart as 17% and 88%, which is
// what made the System tab's CPU gauge spike to 100%. A window of at least
// ~750ms averages over enough ticks to be stable.
const MIN_CPU_WINDOW_MS = 750;
// Beyond this, a retained sample stops describing "now" (e.g. the poll loop was
// paused), so we fall back to taking a fresh short-window sample instead.
const MAX_CPU_WINDOW_MS = 15_000;
// Even with an accurate window, instantaneous system-wide CPU load is genuinely
// bursty under inference (verified against
// '\Processor Information(_Total)\% Processor Time', which swings just as far
// between consecutive 1s samples). Task Manager smooths its gauge rather than
// showing raw per-interval values, so we apply an exponential moving average to
// keep the System tab readable instead of flickering between 10% and 100%.
const CPU_SMOOTHING_ALPHA = 0.35;

let lastCpuSample: CpuSample | null = null;
let smoothedCpuPercent: number | null = null;

function readCpuTotals(): CpuTotals {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export function cpuPercentBetween(start: CpuTotals, end: CpuTotals): number | null {
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return null;
  const percent = (1 - idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, percent));
}

/** Clears the retained CPU sample and smoothing state. Exposed for tests. */
export function resetCpuSampler(): void {
  lastCpuSample = null;
  smoothedCpuPercent = null;
}

/**
 * Applies the exponential moving average used to damp the CPU gauge. Exported
 * so the smoothing behaviour can be unit-tested without touching real os.cpus()
 * timings.
 */
export function smoothCpuPercent(previous: number | null, raw: number | null): number | null {
  if (raw === null) return previous;
  if (previous === null) return raw;
  return previous + CPU_SMOOTHING_ALPHA * (raw - previous);
}

/**
 * Reports CPU utilization from the delta of busy vs. idle ticks across all
 * cores. A single instantaneous os.cpus() reading only gives cumulative totals
 * since boot, so two readings are always required.
 *
 * Whenever possible the previous call's reading is reused as the start of the
 * window, so the measurement spans the caller's whole poll interval (seconds)
 * rather than a freshly-slept `sampleMs`. That both removes the per-poll sleep
 * and makes the value far less noisy — see MIN_CPU_WINDOW_MS.
 */
export function sampleCpuPercent(sampleMs = MIN_CPU_WINDOW_MS): Promise<number | null> {
  const now = Date.now();
  const current = readCpuTotals();
  const previous = lastCpuSample;
  const windowMs = previous ? now - previous.at : 0;

  if (previous && windowMs >= MIN_CPU_WINDOW_MS && windowMs <= MAX_CPU_WINDOW_MS) {
    lastCpuSample = { ...current, at: now };
    smoothedCpuPercent = smoothCpuPercent(smoothedCpuPercent, cpuPercentBetween(previous, current));
    return Promise.resolve(smoothedCpuPercent);
  }

  // No usable retained sample (first call, or the poll loop stalled), so the
  // smoothing history no longer describes the current window either.
  smoothedCpuPercent = null;
  return new Promise((resolve) => {
    setTimeout(() => {
      const end = readCpuTotals();
      lastCpuSample = { ...end, at: Date.now() };
      smoothedCpuPercent = cpuPercentBetween(current, end);
      resolve(smoothedCpuPercent);
    }, Math.max(sampleMs, MIN_CPU_WINDOW_MS));
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

/** Auto-detects the nvidia-smi path (ignoring any override) for display
 *  purposes on the Options tab, e.g. showing "(auto: <path>)" instead of
 *  "(null)" when the user hasn't set an explicit override. */
export function detectNvidiaSmiPath(): string | null {
  return resolveNvidiaSmi(null);
}

/** Auto-detects the amd-smi path (ignoring any override) for display
 *  purposes on the Options tab. */
export function detectAmdSmiPath(): string | null {
  return resolveAmdSmi(null);
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

function sumValues(totals: Map<string, number>): number | null {
  if (totals.size === 0) return null;
  let sum = 0;
  for (const value of totals.values()) sum += value;
  return sum;
}

/** Parses "<counter leaf name>,<value>" lines from the \Memory\* counter set. */
export function parseMemoryPressure(lines: string[]): MemoryPressure | null {
  let committedBytes: number | null = null;
  let commitLimitBytes: number | null = null;
  let pageReadsPerSec: number | null = null;

  for (const line of lines) {
    const idx = line.lastIndexOf(",");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = parseFloat(line.slice(idx + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (name.includes("committed bytes")) committedBytes = value;
    else if (name.includes("commit limit")) commitLimitBytes = value;
    else if (name.includes("page reads")) pageReadsPerSec = value;
  }

  if (committedBytes === null || commitLimitBytes === null || commitLimitBytes <= 0) return null;
  return {
    committedBytes,
    commitLimitBytes,
    availableCommitBytes: Math.max(0, commitLimitBytes - committedBytes),
    pageReadsPerSec,
  };
}

/**
 * Combines the target process's private/working-set bytes with its per-process
 * GPU memory counters into a residency breakdown.
 */
export function buildResidency(
  pid: number | null,
  procLines: string[],
  dedicatedLines: string[],
  sharedLines: string[],
): ProcessMemoryResidency | null {
  if (!pid || pid <= 0) return null;

  let committedBytes: number | null = null;
  let workingSetBytes = 0;
  for (const line of procLines) {
    const idx = line.lastIndexOf(",");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = parseFloat(line.slice(idx + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (name === "private") committedBytes = value;
    else if (name === "workingset") workingSetBytes = value;
  }
  if (committedBytes === null || committedBytes <= 0) return null;

  // A process can hold allocations on more than one adapter, so sum across all
  // of its per-adapter instances.
  const dedicatedBytes = sumValues(sumByLuid(dedicatedLines)) ?? 0;
  const sharedBytes = sumValues(sumByLuid(sharedLines)) ?? 0;

  return {
    pid,
    committedBytes,
    dedicatedBytes,
    sharedBytes,
    elsewhereBytes: Math.max(0, committedBytes - dedicatedBytes - sharedBytes),
    workingSetBytes,
  };
}

export interface DxgiAdapterBudget {
  luidKey: string;
  name: string;
  isSoftware: boolean;
  /** DXGI_ADAPTER_DESC1.DedicatedVideoMemory — Task Manager's "Dedicated GPU memory" total. */
  dedicatedVideoMemoryBytes: number | null;
  /** DXGI_ADAPTER_DESC1.SharedSystemMemory — Task Manager's "Shared GPU memory" total. */
  sharedSystemMemoryBytes: number | null;
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
  "$luid,$($desc.Description),$($desc.Flags),$localBudget,$nonLocalBudget,$($desc.DedicatedVideoMemory.ToUInt64()),$($desc.SharedSystemMemory.ToUInt64())"
  $i++
}
`;

  const output = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 5000);
  if (!output) return result;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 7) continue;
    // The adapter description sits between the LUID and the trailing numeric
    // fields and can itself contain commas, so the numbers are read from the
    // end of the line rather than by fixed index.
    const n = parts.length;
    const luidKey = parts[0]!.toLowerCase();
    const name = parts.slice(1, n - 5).join(",").trim();
    const flags = Number(parts[n - 5]);
    const localBudget = Number(parts[n - 4]);
    const nonLocalBudget = Number(parts[n - 3]);
    const dedicatedVideoMemory = Number(parts[n - 2]);
    const sharedSystemMemory = Number(parts[n - 1]);
    const existing = result.get(luidKey);
    const localBudgetBytes = Number.isFinite(localBudget) && localBudget >= 0 ? localBudget : null;
    const nonLocalBudgetBytes = Number.isFinite(nonLocalBudget) && nonLocalBudget >= 0 ? nonLocalBudget : null;
    const dedicatedVideoMemoryBytes = Number.isFinite(dedicatedVideoMemory) && dedicatedVideoMemory > 0 ? dedicatedVideoMemory : null;
    const sharedSystemMemoryBytes = Number.isFinite(sharedSystemMemory) && sharedSystemMemory > 0 ? sharedSystemMemory : null;
    // Multiple DXGI adapter objects can share the same LUID (hybrid/compute
    // nodes for one physical GPU); keep the entry with the largest budget.
    if (existing && (existing.localBudgetBytes || 0) >= (localBudgetBytes || 0)) continue;
    result.set(luidKey, {
      luidKey,
      name,
      isSoftware: (flags & 0x2) !== 0,
      dedicatedVideoMemoryBytes,
      sharedSystemMemoryBytes,
      localBudgetBytes,
      nonLocalBudgetBytes,
    });
  }

  return result;
}

// Vendor sub-brands and generic suffixes that add no information once the
// vendor and model number are shown ("AMD Radeon(TM) 8060S Graphics" is just
// "AMD 8060S" in a width-constrained label column).
const ADAPTER_NAME_NOISE = /\b(?:graphics|series|family|adapter|compatible|radeon|geforce)\b/gi;

/** Shortens a DXGI adapter description for display in the System tab. */
export function formatAdapterName(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  const shortened = trimmed
    .replace(/\((?:tm|r|c)\)/gi, " ")
    .replace(/[\u2122\u00ae\u00a9]/g, " ")
    .replace(ADAPTER_NAME_NOISE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Some adapters are named entirely from the noise list (e.g. a bare
  // "Video Controller"); keep the original rather than rendering nothing.
  return shortened || trimmed;
}

/**
 * Looks up the DXGI entry for a counter adapter key.
 *
 * The DXGI enumeration always reports `_phys_0`, but counter instances can
 * carry a different physical-node suffix for the same LUID, so a direct key
 * match is not sufficient. Falling back to the LUID alone keeps real adapters
 * identifiable (and therefore visible) on multi-node systems.
 */
export function findDxgiAdapter(
  budgets: Map<string, DxgiAdapterBudget>,
  adapterKey: string,
): DxgiAdapterBudget | undefined {
  const direct = budgets.get(adapterKey);
  if (direct) return direct;
  const base = adapterKey.replace(/_phys_\d+$/i, "");
  if (base === adapterKey) return undefined;
  for (const [key, value] of budgets) {
    if (key.replace(/_phys_\d+$/i, "") === base) return value;
  }
  return undefined;
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
  // Prefer the adapter descriptor's fixed capacity: it is what Task Manager
  // shows as the Dedicated/Shared GPU memory total. The DXGI *budget* is a
  // dynamic, driver-chosen allowance and on unified-memory APUs it spans the
  // combined dedicated+shared pool (measured 110.72GB where the real dedicated
  // carve-out is 63.83GB), which made the System tab's totals look wrong.
  const capacity = segment === "local" ? dxgi.dedicatedVideoMemoryBytes : dxgi.sharedSystemMemoryBytes;
  if (capacity && capacity > 0) return capacity;
  const budget = segment === "local" ? dxgi.localBudgetBytes : dxgi.nonLocalBudgetBytes;
  return budget && budget > 0 ? budget : null;
}

// Enumerating '\GPU Engine(*)' can take several seconds on machines with many
// cores/processes (measured ~2.0s for the combined query on a 32-core APU),
// and a timeout here silently demotes the System tab to a less accurate
// fallback source, so this is deliberately generous.
const GPU_COUNTER_TIMEOUT_MS = 15000;

interface WindowsCountersPayload {
  gpus: GpuSnapshot[];
  error: string | null;
  sharedGpuRamBytes: number | null;
  residency: ProcessMemoryResidency | null;
  pressure: MemoryPressure | null;
}

function emptyPayload(error: string | null): WindowsCountersPayload {
  return { gpus: [], error, sharedGpuRamBytes: null, residency: null, pressure: null };
}

async function getWindowsCounterGpuSnapshots(serverPid?: number | null): Promise<WindowsCountersPayload> {
  if (os.platform() !== "win32") {
    return emptyPayload("Windows performance counters are only available on Windows");
  }

  // A single powershell invocation gathers all counter sets to avoid paying
  // process-spawn overhead per refresh, and issues them as one combined
  // Get-Counter query: querying the paths separately measured 5.1-5.4s on a
  // 32-core APU, which exceeded the caller's timeout and silently demoted the
  // System tab to a fallback source. One combined query measures ~2.0s even
  // with the extra memory/process counters folded in.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$targetPid = ${Math.max(0, Math.floor(serverPid ?? 0))}
$paths = @(
  '\\GPU Engine(*)\\Utilization Percentage',
  '\\GPU Adapter Memory(*)\\Dedicated Usage',
  '\\GPU Adapter Memory(*)\\Dedicated Usage Limit',
  '\\GPU Adapter Memory(*)\\Shared Usage',
  '\\GPU Adapter Memory(*)\\Shared Usage Limit',
  '\\GPU Process Memory(*)\\Dedicated Usage',
  '\\GPU Process Memory(*)\\Shared Usage',
  '\\Memory\\Committed Bytes',
  '\\Memory\\Commit Limit',
  '\\Memory\\Page Reads/sec'
)
$buckets = [ordered]@{
  UTIL = @(); DEDICATED_USED = @(); DEDICATED_LIMIT = @(); SHARED_USED = @(); SHARED_LIMIT = @()
  PROC_DEDICATED = @(); PROC_SHARED = @(); MEM = @(); PROC = @()
}
function Classify($samplePath) {
  # 'GPU Process Memory' and 'GPU Adapter Memory' share leaf counter names, so
  # the per-process set must be matched before the per-adapter suffixes.
  if ($samplePath -like '*\\utilization percentage') { return 'UTIL' }
  if ($samplePath -like '*gpu process memory*') {
    if ($samplePath -like '*\\dedicated usage') { return 'PROC_DEDICATED' }
    if ($samplePath -like '*\\shared usage') { return 'PROC_SHARED' }
    return $null
  }
  if ($samplePath -like '*\\dedicated usage limit') { return 'DEDICATED_LIMIT' }
  if ($samplePath -like '*\\dedicated usage') { return 'DEDICATED_USED' }
  if ($samplePath -like '*\\shared usage limit') { return 'SHARED_LIMIT' }
  if ($samplePath -like '*\\shared usage') { return 'SHARED_USED' }
  if ($samplePath -like '*\\committed bytes') { return 'MEM' }
  if ($samplePath -like '*\\commit limit') { return 'MEM' }
  if ($samplePath -like '*\\page reads/sec') { return 'MEM' }
  return $null
}
function Collect($samples) {
  foreach ($s in $samples) {
    $key = Classify $s.Path
    if (-not $key) { continue }
    if ($key -eq 'MEM') {
      $buckets[$key] += "$($s.Path -replace '.*\\\\',''),$($s.CookedValue)"
    } elseif ($key -eq 'PROC_DEDICATED' -or $key -eq 'PROC_SHARED') {
      if ($targetPid -gt 0 -and $s.InstanceName -like "pid_$($targetPid)_*") {
        $buckets[$key] += "$($s.InstanceName),$($s.CookedValue)"
      }
    } else {
      $buckets[$key] += "$($s.InstanceName),$($s.CookedValue)"
    }
  }
}
Collect (Get-Counter -Counter $paths -ErrorAction SilentlyContinue).CounterSamples
if ((($buckets.Values | ForEach-Object { $_.Count }) | Measure-Object -Sum).Sum -eq 0) {
  # Get-Counter's array form fails as a unit if any single path is unknown on
  # this machine, so retry each path independently before giving up.
  foreach ($p in $paths) {
    Collect (Get-Counter -Counter $p -ErrorAction SilentlyContinue).CounterSamples
  }
}
if ($targetPid -gt 0) {
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($proc) {
    $buckets['PROC'] += "private,$($proc.PrivateMemorySize64)"
    $buckets['PROC'] += "workingset,$($proc.WorkingSet64)"
  }
}
foreach ($key in $buckets.Keys) {
  "---$key---"
  $buckets[$key]
}
`;

  const queryOnce = async (): Promise<WindowsCountersPayload> => {
    const [output, dxgiBudgets] = await Promise.all([
      runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], GPU_COUNTER_TIMEOUT_MS),
      getDxgiAdapterBudgets(),
    ]);
    if (!output) {
      return emptyPayload("Windows counters: could not read GPU performance counters");
    }

    const sections: Record<string, string[]> = {
      UTIL: [], DEDICATED_USED: [], DEDICATED_LIMIT: [], SHARED_USED: [], SHARED_LIMIT: [],
      PROC_DEDICATED: [], PROC_SHARED: [], MEM: [], PROC: [],
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

    const pressure = parseMemoryPressure(sections.MEM!);
    const residency = buildResidency(
      serverPid ?? null,
      sections.PROC!,
      sections.PROC_DEDICATED!,
      sections.PROC_SHARED!,
    );
    const sharedGpuRamBytes = sumValues(sharedUsedByLuid);

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
      return { ...emptyPayload("Windows counters: no GPU adapters reported"), residency, pressure };
    }

    // Only adapters that enumerate through DXGI as hardware are real GPUs.
    // This drops the WARP/"Microsoft Basic Render Driver" software adapter
    // (flagged by DXGI) and indirect-display devices such as the Remote
    // Display Adapter, which register memory counters but never enumerate in
    // DXGI at all. Both otherwise show up as permanently-idle 0% rows.
    const isRealGpu = (key: string): boolean => {
      const dxgi = findDxgiAdapter(dxgiBudgets, key);
      return dxgi !== undefined && !dxgi.isSoftware;
    };
    const realKeys = Array.from(adapterKeys).filter(isRealGpu);
    // If DXGI is unavailable (or matched nothing), fall back to showing every
    // adapter rather than rendering an empty GPU section.
    const visibleKeys = realKeys.length > 0 ? realKeys : Array.from(adapterKeys);

    const gpus: GpuSnapshot[] = visibleKeys.map((key, i) => {
      const dxgi = findDxgiAdapter(dxgiBudgets, key);
      const dedicatedTotalBytes = resolveAdapterTotalBytes(dedicatedLimitByLuid.get(key), dxgi, "local");
      const sharedTotalBytes = resolveAdapterTotalBytes(sharedLimitByLuid.get(key), dxgi, "nonLocal");
      return {
        label: formatAdapterName(dxgi?.name || "") || `GPU ${i + 1}`,
        source: "Windows counters",
        utilizationPercent: utilByLuid.has(key) ? Math.min(100, utilByLuid.get(key)!) : null,
        dedicatedUsedBytes: dedicatedUsedByLuid.get(key) ?? null,
        dedicatedTotalBytes,
        sharedUsedBytes: sharedUsedByLuid.get(key) ?? null,
        sharedTotalBytes,
      };
    });

    gpus.sort((a, b) => (b.dedicatedTotalBytes || 0) - (a.dedicatedTotalBytes || 0));
    // Only unnamed adapters need positional labels; renumber them after the
    // sort so the fallback names stay in displayed order.
    gpus.forEach((g, i) => {
      if (/^GPU \d+$/.test(g.label)) g.label = `GPU ${i + 1}`;
    });

    return { gpus, error: null, sharedGpuRamBytes, residency, pressure };
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

export interface HipSdkStatus {
  installed: boolean;
  /** Best-effort detail (e.g. detected version/path) when installed; cheap
   *  env-var/filesystem checks only, no CLI invocation. */
  detail: string | null;
}

/** Reports whether the AMD HIP/ROCm SDK tooling appears to be installed
 *  (used by the Options tab's amdSdkTools row to decide between "Open HIP
 *  SDK tools page" and showing an installed-status summary). */
export function getHipSdkStatus(): HipSdkStatus {
  if (!hipSdkDetected()) return { installed: false, detail: null };

  for (const envVar of ["HIP_PATH", "HIP_PATH_57", "ROCM_PATH"]) {
    const root = process.env[envVar];
    if (!root) continue;
    const versionMatch = root.match(/[\\/](\d+\.\d+(?:\.\d+)?)[\\/]?$/);
    return { installed: true, detail: versionMatch ? `v${versionMatch[1]} (${root})` : root };
  }
  return { installed: true, detail: null };
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
export async function getGpuTelemetrySources(config?: ConfigData | null, serverPid?: number | null): Promise<GpuTelemetrySourceSnapshot[]> {
  return (await collectTelemetry(config, serverPid)).sources;
}

/**
 * Runs the source cascade once and returns both the per-source GPU snapshots
 * and the memory/residency detail that the Windows counter query collects in
 * the same invocation (so the System tab never pays for a second query).
 */
async function collectTelemetry(
  config?: ConfigData | null,
  serverPid?: number | null,
): Promise<{ sources: GpuTelemetrySourceSnapshot[]; windows: WindowsCountersPayload | null }> {
  const settings = telemetrySettings(config);
  if (settings.mode === "disabled") {
    return {
      sources: [sourceResult("disabled", "Disabled", { gpus: [], error: "GPU telemetry is disabled in Options" })],
      windows: null,
    };
  }

  const sources: GpuTelemetrySourceSnapshot[] = [];
  let windows: WindowsCountersPayload | null = null;

  if (settings.mode === "auto" || settings.mode === "windows") {
    windows = await getWindowsCounterGpuSnapshots(serverPid);
    sources.push(sourceResult("windows", "Windows counters", windows));
  }

  if (settings.mode === "auto" || settings.mode === "vendor") {
    sources.push(sourceResult("nvidia", "nvidia-smi", await getNvidiaSmiGpuSnapshots(settings)));
    sources.push(sourceResult("amd", "amd-smi", await getAmdSmiGpuSnapshots(settings)));
  }

  if (settings.mode === "auto" || settings.mode === "vulkan") {
    sources.push(sourceResult("vulkan", "Vulkan (ggml)", await getVulkanGpuSnapshots(config)));
  }

  if (sources.length === 0) {
    sources.push(sourceResult("none", "None", { gpus: [], error: "No GPU telemetry sources available" }));
  }
  return { sources, windows };
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

export async function getSystemSnapshot(config?: ConfigData | null, serverPid?: number | null): Promise<SystemSnapshot> {
  const [cpuPercent, telemetry] = await Promise.all([
    sampleCpuPercent(),
    collectTelemetry(config, serverPid),
  ]);
  const gpuResult = telemetry.sources;
  const { usedBytes, totalBytes } = getMemoryInfo();
  const firstAvailable = gpuResult.find((source) => source.gpus.length > 0);
  const gpus = firstAvailable?.gpus || [];

  // Real installed memory is RAM plus the firmware VRAM carve-out, which
  // Windows never sees. Shared VRAM is deliberately excluded: it is an aperture
  // onto RAM that is already counted in ramUsedBytes, so including it would
  // double-count (the mistake behind Task Manager's "GPU Memory" total).
  let dedicatedUsed = 0;
  let dedicatedTotal = 0;
  for (const gpu of gpus) {
    if (gpu.dedicatedTotalBytes && gpu.dedicatedTotalBytes > 0) {
      dedicatedTotal += gpu.dedicatedTotalBytes;
      dedicatedUsed += gpu.dedicatedUsedBytes ?? 0;
    }
  }
  const hasDedicated = dedicatedTotal > 0;

  return {
    cpuPercent,
    ramUsedBytes: usedBytes,
    ramTotalBytes: totalBytes,
    sharedGpuRamBytes: telemetry.windows?.sharedGpuRamBytes ?? null,
    systemwideUsedBytes: hasDedicated ? usedBytes + dedicatedUsed : null,
    systemwideTotalBytes: hasDedicated ? totalBytes + dedicatedTotal : null,
    residency: telemetry.windows?.residency ?? null,
    pressure: telemetry.windows?.pressure ?? null,
    gpuSources: gpuResult,
    gpus,
    gpuError: firstAvailable ? null : gpuResult.map((source) => source.error).filter(Boolean).join(" | "),
  };
}
