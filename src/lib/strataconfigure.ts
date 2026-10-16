import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

/**
 * Manager-side tuning around upstream Strata setup (Configure). Setup regenerates a config from
 * its own defaults on every run and drops engine options it does not choose, so options that
 * setup recommends only as text (prefill, conversation cache) and the measured decision to keep
 * the KV cache in VRAM are reapplied here after a successful Configure.
 */

/** Setup's KV bytes per context cell (KV_CELL_BYTES; int8 is its default 1056). */
const KV_CELL_BYTES: Record<string, number> = { q4_0: 576, k8v4: 816 };
const DEFAULT_KV_CELL_BYTES = 1056;
/** 12 QSA layers + the draft layer, as setup's kv_streaming_ram_gb() counts them. */
const KV_LAYERS = 13;
/** VRAM that must stay free after moving the streamed KV cache into VRAM. */
export const KV_VRAM_MARGIN_MIB = 2048;
/** Setup warns that --prefill auto:32768 ran ~3x slower below this much RAM (PREFILL_RISK_RAM_GB). */
export const PREFILL_MIN_RAM_GIB = 64;
export const PREFILL_CHUNK = "auto:32768";
/** Largest model RAM in setup's MODELS (62) + its AGENT_CACHE_FREE_GB (24): enough for any model. */
export const CONVERSATION_CACHE_MIN_RAM_GIB = 86;
export const CONVERSATION_CACHE_MIB = "8192";
const LOG_TAIL_BYTES = 8 * 1024 * 1024;

export interface StrataLoadMeasurement {
  /** Local wall-clock time of the engine start line. */
  startedAt: Date;
  context: number | null;
  kv: string;
  /** Cells per QSA layer kept in VRAM while streaming; null when the KV cache was not streamed. */
  kvResidentCells: number | null;
  profilePairs: number;
  expertSlots: number;
  vramFreeMib: number;
}

function flagValue(commandLine: string, flag: string): string | null {
  const match = new RegExp(`(?:^|\\s)${flag}\\s+(\\S+)`).exec(commandLine);
  return match ? match[1]! : null;
}

/** Parses the latest completed engine load from a Strata engine log, or null if none completed. */
export function parseStrataLoadMeasurement(logText: string): StrataLoadMeasurement | null {
  const starts = [...logText.matchAll(/^\[strata\] (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) engine started: (.*)$/gm)];
  const last = starts.at(-1);
  if (!last || last.index === undefined) return null;
  const segment = logText.slice(last.index);
  const [, y, mo, d, h, mi, s, commandLine] = last;
  const startedAt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));

  const pairs = /^strata generate: profile .*: (\d+) ranked pairs/m.exec(segment);
  const slots = [...segment.matchAll(/^strata generate: expert cache (\d+) slots, [\d.]+ GiB of VRAM/gm)].at(-1);
  const free = /^strata serve: (\d+) MiB of VRAM free with everything loaded/m.exec(segment);
  if (!pairs || !slots || !free || !/session is up/.test(segment)) return null;

  const streamed = /^strata generate: KV streaming: (\d+) of (\d+) cells per QSA layer in VRAM/m.exec(segment);
  const contextFlag = flagValue(commandLine!, "--max-context");
  return {
    startedAt,
    context: streamed ? Number(streamed[2]) : contextFlag ? Number(contextFlag) : null,
    kv: flagValue(commandLine!, "--kv") ?? "int8",
    kvResidentCells: streamed ? Number(streamed[1]) : null,
    profilePairs: Number(pairs[1]),
    expertSlots: Number(slots[1]),
    vramFreeMib: Number(free[1]),
  };
}

export function kvCacheBytes(cells: number, kv: string): number {
  return cells * KV_LAYERS * (KV_CELL_BYTES[kv] ?? DEFAULT_KV_CELL_BYTES);
}

export interface KvDecision {
  keepInVram: boolean;
  reason: string;
}

/**
 * Keeps the whole KV cache in VRAM only when the latest load on this boot held every profiled
 * expert in the GPU cache and still had room for the KV cells it streamed, plus a margin.
 * A load from before the last reboot is ignored: the BIOS memory split may have changed.
 */
export function decideKvInVram(
  m: StrataLoadMeasurement | null,
  target: { context: number; kv: string },
  bootTimeMs: number,
): KvDecision {
  if (!m) return { keepInVram: false, reason: "no completed load of this model was measured" };
  if (m.startedAt.getTime() < bootTimeMs) {
    return { keepInVram: false, reason: "the last measured load was before the latest restart" };
  }
  if (m.expertSlots < m.profilePairs) {
    return { keepInVram: false, reason: `the last load held ${m.expertSlots} of ${m.profilePairs} experts in VRAM` };
  }
  const inVramCells = m.kvResidentCells ?? m.context ?? 0;
  const extraMib = Math.max(0, kvCacheBytes(target.context, target.kv) - kvCacheBytes(inVramCells, m.kv)) / 2 ** 20;
  const leftMib = m.vramFreeMib - extraMib;
  if (leftMib < KV_VRAM_MARGIN_MIB) {
    return {
      keepInVram: false,
      reason: `the KV cache needs ${Math.ceil(extraMib)} MiB more VRAM; the last load had ${m.vramFreeMib} MiB free`,
    };
  }
  return {
    keepInVram: true,
    reason: `the last load held all ${m.profilePairs} experts with ${m.vramFreeMib} MiB VRAM free`
      + (extraMib > 0 ? ` (${Math.round(leftMib)} MiB left with the KV cache)` : ""),
  };
}

export interface TuneResult {
  args: string[];
  changes: string[];
}

/** Applies the manager's Configure tuning rules to a generated config's engine args. */
export function tuneStrataArgs(args: readonly string[], input: { ramGiB: number; kv: KvDecision }): TuneResult {
  const out = [...args];
  const changes: string[] = [];
  const kvIdx = out.indexOf("--kv-resident");
  if (kvIdx >= 0) {
    if (input.kv.keepInVram) {
      out.splice(kvIdx, kvIdx + 1 < out.length ? 2 : 1);
      changes.push(`KV cache kept in VRAM (--kv-resident removed): ${input.kv.reason}`);
    } else {
      changes.push(`KV streaming kept: ${input.kv.reason}`);
    }
  }
  const prefillIdx = out.indexOf("--prefill");
  if (prefillIdx >= 0 && out[prefillIdx + 1] === "auto" && input.ramGiB >= PREFILL_MIN_RAM_GIB) {
    out[prefillIdx + 1] = PREFILL_CHUNK;
    changes.push(`--prefill ${PREFILL_CHUNK} (${input.ramGiB.toFixed(0)} GiB RAM)`);
  }
  if (!out.includes("--conversation-cache-mib") && input.ramGiB >= CONVERSATION_CACHE_MIN_RAM_GIB) {
    out.push("--conversation-cache-mib", CONVERSATION_CACHE_MIB);
    changes.push(`--conversation-cache-mib ${CONVERSATION_CACHE_MIB}`);
  }
  return { args: out, changes };
}

/** The --vram-reserve-mib of an existing config, to hand back to setup (which remembers it). */
export async function readConfigVramReserve(configPath: string | null | undefined): Promise<number | null> {
  if (!configPath) return null;
  try {
    const obj = await fs.readJson(configPath) as { args?: unknown };
    if (!Array.isArray(obj.args)) return null;
    const i = obj.args.indexOf("--vram-reserve-mib");
    const value = i >= 0 ? Number(obj.args[i + 1]) : NaN;
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function readLogTail(file: string): Promise<string> {
  const stat = await fs.stat(file);
  const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
  const fd = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await fs.read(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await fs.close(fd);
  }
}

export interface TuneConfigDeps {
  ramGiB?: number;
  bootTimeMs?: number;
}

/**
 * Tunes one generated config in place. Only engine args change; other keys and their order are
 * kept. Returns the changes made (empty when nothing applied).
 */
export async function tuneStrataConfigFile(file: string, deps: TuneConfigDeps = {}): Promise<string[]> {
  const obj = await fs.readJson(file) as Record<string, unknown>;
  if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) return [];
  const args = obj.args as string[];
  const ctxIdx = args.indexOf("--max-context");
  const context = ctxIdx >= 0 ? Number(args[ctxIdx + 1]) : NaN;
  const kvIdx = args.indexOf("--kv");
  const kv = kvIdx >= 0 ? args[kvIdx + 1]! : "int8";
  let measurement: StrataLoadMeasurement | null = null;
  if (typeof obj.log === "string") {
    const log = path.isAbsolute(obj.log) ? obj.log : path.join(path.dirname(file), obj.log);
    measurement = await readLogTail(log).then(parseStrataLoadMeasurement, () => null);
  }
  const kvDecision = Number.isFinite(context)
    ? decideKvInVram(measurement, { context, kv }, deps.bootTimeMs ?? Date.now() - os.uptime() * 1000)
    : { keepInVram: false, reason: "the config has no --max-context" };
  const result = tuneStrataArgs(args, { ramGiB: deps.ramGiB ?? os.totalmem() / 2 ** 30, kv: kvDecision });
  if (result.args.join("\u0000") !== args.join("\u0000")) {
    obj.args = result.args;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(obj, null, 1)}\n`, "utf8");
    await fs.move(tmp, file, { overwrite: true });
  }
  return result.changes;
}

/** Tunes every config Configure wrote during the run (modified at or after it started). */
export async function tuneConfiguredStrataConfigs(
  configFiles: readonly string[],
  startedAtMs: number,
  deps: TuneConfigDeps = {},
): Promise<Array<{ file: string; changes: string[]; error?: string }>> {
  const results: Array<{ file: string; changes: string[]; error?: string }> = [];
  for (const file of configFiles) {
    try {
      if ((await fs.stat(file)).mtimeMs < startedAtMs) continue;
      results.push({ file, changes: await tuneStrataConfigFile(file, deps) });
    } catch (error) {
      results.push({ file, changes: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
