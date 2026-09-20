import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import type { ConfigData } from "./config";

export type GpuTelemetryMode = "auto" | "windows" | "vendor" | "disabled";

export interface GpuTelemetrySettings {
  mode: GpuTelemetryMode;
  nvidiaSmiPath: string | null;
  amdSmiPath: string | null;
  allowAmdSmiWindows: boolean;
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

  const output = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 5000);
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

  const adapterKeys = new Set<string>([...dedicatedLimitByLuid.keys(), ...sharedLimitByLuid.keys()]);
  if (adapterKeys.size === 0) {
    return { gpus: [], error: "Windows counters: no GPU adapters reported" };
  }

  const gpus: GpuSnapshot[] = Array.from(adapterKeys).map((key, i) => ({
    label: `GPU ${i + 1}`,
    source: "Windows counters",
    utilizationPercent: utilByLuid.has(key) ? Math.min(100, utilByLuid.get(key)!) : null,
    dedicatedUsedBytes: dedicatedUsedByLuid.get(key) ?? null,
    dedicatedTotalBytes: dedicatedLimitByLuid.get(key) ?? null,
    sharedUsedBytes: sharedUsedByLuid.get(key) ?? null,
    sharedTotalBytes: sharedLimitByLuid.get(key) ?? null,
  }));

  gpus.sort((a, b) => (b.dedicatedTotalBytes || 0) - (a.dedicatedTotalBytes || 0));
  gpus.forEach((g, i) => { g.label = `GPU ${i + 1}`; });

  return { gpus, error: null };
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

/**
 * Collects per-adapter GPU utilization and VRAM using the configured source
 * cascade. In auto mode:
 *  1. Windows performance counters
 *  2. NVIDIA nvidia-smi
 *  3. AMD amd-smi (gated on Windows)
 */
export async function getGpuSnapshots(config?: ConfigData | null): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  const settings = telemetrySettings(config);
  if (settings.mode === "disabled") {
    return { gpus: [], error: "GPU telemetry is disabled in Options" };
  }

  const errors: string[] = [];
  const trySource = async (fn: () => Promise<{ gpus: GpuSnapshot[]; error: string | null }>) => {
    const result = await fn();
    if (result.gpus.length > 0) return result;
    if (result.error) errors.push(result.error);
    return null;
  };

  if (settings.mode === "auto" || settings.mode === "windows") {
    const result = await trySource(() => getWindowsCounterGpuSnapshots());
    if (result) return result;
    if (settings.mode === "windows") return { gpus: [], error: errors.join(" | ") || "No GPU telemetry available" };
  }

  if (settings.mode === "auto" || settings.mode === "vendor") {
    const nvidia = await trySource(() => getNvidiaSmiGpuSnapshots(settings));
    if (nvidia) return nvidia;
    const amd = await trySource(() => getAmdSmiGpuSnapshots(settings));
    if (amd) return amd;
  }

  return { gpus: [], error: errors.join(" | ") || "No GPU telemetry sources available" };
}

export async function getSystemSnapshot(config?: ConfigData | null): Promise<SystemSnapshot> {
  const [cpuPercent, gpuResult] = await Promise.all([
    sampleCpuPercent(),
    getGpuSnapshots(config),
  ]);
  const { usedBytes, totalBytes } = getMemoryInfo();

  return {
    cpuPercent,
    ramUsedBytes: usedBytes,
    ramTotalBytes: totalBytes,
    gpus: gpuResult.gpus,
    gpuError: gpuResult.error,
  };
}
