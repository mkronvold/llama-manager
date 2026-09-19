import os from "os";
import { spawn } from "child_process";

export interface GpuSnapshot {
  label: string;
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
  /** Set when GPU stats couldn't be collected at all (e.g. non-Windows, no permissions). */
  gpuError: string | null;
}

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
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.stdout?.on("data", (d) => { out += d.toString(); });
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

/**
 * Collects per-adapter GPU utilization and VRAM (dedicated + shared) via
 * Windows' built-in "GPU Engine" and "GPU Adapter Memory" performance counters
 * (the same data source Task Manager's Performance tab uses). There is no
 * equivalent built-in, driver-agnostic API on Linux/macOS, so this is
 * Windows-only; other platforms fall back to null with an explanatory message.
 */
export async function getGpuSnapshots(): Promise<{ gpus: GpuSnapshot[]; error: string | null }> {
  if (os.platform() !== "win32") {
    return { gpus: [], error: "GPU stats are only available on Windows" };
  }

  // A single powershell invocation gathers all four counter sets to avoid
  // paying process-spawn overhead four times per refresh. Errors from any
  // individual Get-Counter call (e.g. a counter set missing on older Windows
  // builds) are swallowed with -ErrorAction SilentlyContinue so one missing
  // counter set doesn't blank out the others.
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
    return { gpus: [], error: "Could not read GPU performance counters" };
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

  // "GPU Adapter Memory" is the authoritative list of physical adapters (one
  // entry per adapter, unlike "GPU Engine" which has many rows per adapter -
  // one per engine type/process); use its keys to enumerate adapters.
  const adapterKeys = new Set<string>([...dedicatedLimitByLuid.keys(), ...sharedLimitByLuid.keys()]);
  if (adapterKeys.size === 0) {
    return { gpus: [], error: "No GPU adapters reported by performance counters" };
  }

  const gpus: GpuSnapshot[] = Array.from(adapterKeys).map((key, i) => ({
    label: `GPU ${i + 1}`,
    utilizationPercent: utilByLuid.has(key) ? Math.min(100, utilByLuid.get(key)!) : null,
    dedicatedUsedBytes: dedicatedUsedByLuid.get(key) ?? null,
    dedicatedTotalBytes: dedicatedLimitByLuid.get(key) ?? null,
    sharedUsedBytes: sharedUsedByLuid.get(key) ?? null,
    sharedTotalBytes: sharedLimitByLuid.get(key) ?? null,
  }));

  // Sort discrete/high-VRAM adapters first (dedicated limit descending) so the
  // GPU the user actually cares about for inference appears at the top.
  gpus.sort((a, b) => (b.dedicatedTotalBytes || 0) - (a.dedicatedTotalBytes || 0));
  gpus.forEach((g, i) => { g.label = `GPU ${i + 1}`; });

  return { gpus, error: null };
}

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  const [cpuPercent, gpuResult] = await Promise.all([
    sampleCpuPercent(),
    getGpuSnapshots(),
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
