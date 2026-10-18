import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { STRATA_KV_RESIDENT_DEFAULT, type StrataEngineOverrides } from "./runtime";

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

export function defaultBootTimeMs(): number {
  return Date.now() - os.uptime() * 1000;
}

/** The latest completed load recorded in a config's engine log, or null. */
export async function readConfigLoadMeasurement(
  obj: Record<string, unknown>,
  file: string,
): Promise<StrataLoadMeasurement | null> {
  if (typeof obj.log !== "string") return null;
  const log = path.isAbsolute(obj.log) ? obj.log : path.join(path.dirname(file), obj.log);
  return readLogTail(log).then(parseStrataLoadMeasurement, () => null);
}

function flagArg(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

function setFlagArg(args: string[], flag: string, value: string | null): void {
  const i = args.indexOf(flag);
  if (value === null) {
    if (i >= 0) args.splice(i, i + 1 < args.length ? 2 : 1);
  } else if (i >= 0 && i + 1 < args.length) {
    args[i + 1] = value;
  } else if (i >= 0) {
    args.push(value);
  } else {
    args.push(flag, value);
  }
}

/** Engine args with a profile's overrides applied (context, KV streaming, prefill, batch slots, batch MTP). */
export function applyStrataOverrides(args: readonly string[], overrides: StrataEngineOverrides | undefined): string[] {
  const out = [...args];
  if (!overrides) return out;
  if (overrides.maxContext !== undefined) setFlagArg(out, "--max-context", String(overrides.maxContext));
  if (overrides.kvStreaming === "off") {
    setFlagArg(out, "--kv-resident", null);
  } else if (overrides.kvStreaming === "on") {
    const cells = overrides.kvResidentCells ?? Number(flagArg(out, "--kv-resident") ?? STRATA_KV_RESIDENT_DEFAULT);
    setFlagArg(out, "--kv-resident", String(cells));
  } else if (overrides.kvResidentCells !== undefined && out.includes("--kv-resident")) {
    setFlagArg(out, "--kv-resident", String(overrides.kvResidentCells));
  }
  if (overrides.prefill !== undefined) setFlagArg(out, "--prefill", overrides.prefill);
  // The server ignores the config's "parallel" when the args already choose batch slots.
  if (overrides.parallel !== undefined) {
    setFlagArg(out, "--batch", null);
    setFlagArg(out, "--slots", null);
  }
  if (overrides.batchMtp === "on" && !out.includes("--batch-mtp")) out.push("--batch-mtp");
  if (overrides.batchMtp === "off") {
    for (let i = out.indexOf("--batch-mtp"); i >= 0; i = out.indexOf("--batch-mtp")) out.splice(i, 1);
  }
  return out;
}

/** Batch slots the server runs for a config: "parallel" unless the args choose --batch/--slots. */
export function strataBatchSlots(args: readonly string[], parallel: unknown): number {
  const fromArgs = flagArg(args, "--batch") ?? flagArg(args, "--slots");
  const n = fromArgs !== null ? Number(fromArgs) : typeof parallel === "number" ? parallel : 1;
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/**
 * A generated config object with a profile's overrides applied: engine args plus the top-level
 * "parallel" (removed for one request at a time). Other keys are kept.
 */
export function applyStrataConfigOverrides(
  obj: Record<string, unknown>,
  overrides: StrataEngineOverrides | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === "string") : [];
  out.args = applyStrataOverrides(args, overrides);
  if (overrides?.parallel !== undefined) {
    if (overrides.parallel > 1) out.parallel = overrides.parallel; else delete out.parallel;
  }
  return out;
}

/** Rough VRAM one batch slot's session takes: its KV cells in VRAM plus ~128 MiB of other state. */
function batchSlotMib(args: readonly string[]): number {
  const context = Number(flagArg(args, "--max-context") ?? 0);
  const resident = flagArg(args, "--kv-resident");
  const cells = resident !== null ? Math.min(Number(resident), context || Number(resident)) : context;
  return kvCacheBytes(Number.isFinite(cells) ? cells : 0, flagArg(args, "--kv") ?? "int8") / 2 ** 20 + 128;
}

/**
 * Non-blocking warnings for a profile's overrides: whole KV cache in VRAM where the last measured
 * load suggests it will not fit, streaming that keeps the whole context in VRAM anyway, batch slots
 * that would shrink the expert cache, and batch MTP without batch slots.
 */
export function strataOverrideWarnings(
  configArgs: readonly string[],
  overrides: StrataEngineOverrides | undefined,
  measurement: StrataLoadMeasurement | null,
  bootTimeMs: number,
  configParallel: unknown = undefined,
): string[] {
  if (!overrides) return [];
  const effective = applyStrataOverrides(configArgs, overrides);
  const context = Number(flagArg(effective, "--max-context"));
  const kv = flagArg(effective, "--kv") ?? "int8";
  const resident = flagArg(effective, "--kv-resident");
  const slots = strataBatchSlots(effective, overrides.parallel ?? configParallel);
  const warnings: string[] = [];
  const touchesKv = overrides.kvStreaming !== undefined || overrides.maxContext !== undefined;
  if (touchesKv && resident === null && Number.isFinite(context)) {
    const decision = decideKvInVram(measurement, { context, kv }, bootTimeMs);
    if (!decision.keepInVram) warnings.push(`whole KV cache in VRAM may not fit: ${decision.reason}`);
  }
  if (resident !== null && Number.isFinite(context) && Number(resident) >= context) {
    warnings.push(`KV streaming keeps ${resident} cells in VRAM, the whole ${context}-token context: it streams nothing`);
  }
  const touchesSlots = touchesKv || overrides.parallel !== undefined || overrides.batchMtp !== undefined;
  if (touchesSlots && slots > 1) {
    const needMib = Math.ceil(slots * batchSlotMib(effective));
    const freeMib = measurement && measurement.startedAt.getTime() >= bootTimeMs ? measurement.vramFreeMib : null;
    if (freeMib === null) {
      warnings.push(`${slots} batch slots take about ${needMib} MiB of VRAM; no load since boot was measured to compare`);
    } else if (needMib > freeMib - KV_VRAM_MARGIN_MIB) {
      warnings.push(`${slots} batch slots take about ${needMib} MiB of VRAM; the last load had ${freeMib} MiB free, `
        + "so the expert cache will shrink");
    }
  }
  if (overrides.batchMtp === "on" && slots <= 1) warnings.push("batch MTP does nothing without parallel 2 or more");
  return warnings;
}

/** strataOverrideWarnings for a generated config file, using its engine log's last measured load. */
export async function readStrataOverrideWarnings(
  configPath: string,
  overrides: StrataEngineOverrides | undefined,
): Promise<string[]> {
  if (!overrides) return [];
  const obj = await fs.readJson(configPath).catch(() => null) as Record<string, unknown> | null;
  if (!obj || !Array.isArray(obj.args)) return [];
  const args = obj.args.filter((a): a is string => typeof a === "string");
  return strataOverrideWarnings(
    args, overrides, await readConfigLoadMeasurement(obj, configPath), defaultBootTimeMs(), obj.parallel,
  );
}

/**
 * Writes the config a session launches when its profile overrides engine settings: a copy of the
 * generated config with overridden args and "parallel", in `dir` as <sessionId>.json. Returns null
 * (launch the generated config itself) when the overrides change nothing. Earlier launch copies are removed.
 */
export async function writeStrataLaunchConfig(
  sourcePath: string,
  overrides: StrataEngineOverrides | undefined,
  dir: string,
  sessionId: string,
): Promise<string | null> {
  await fs.ensureDir(dir);
  for (const entry of await fs.readdir(dir)) {
    if (entry.endsWith(".json") || entry.endsWith(".tmp")) await fs.remove(path.join(dir, entry)).catch(() => undefined);
  }
  if (!overrides) return null;
  const obj = await fs.readJson(sourcePath) as Record<string, unknown>;
  if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) {
    throw new Error(`Strata config has no engine args: ${sourcePath}`);
  }
  const next = applyStrataConfigOverrides(obj, overrides);
  if (JSON.stringify(next) === JSON.stringify(obj)) return null;
  const file = path.join(dir, `${sessionId}.json`);
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(next, null, 1)}\n`, "utf8");
  await fs.move(`${file}.tmp`, file, { overwrite: true });
  return file;
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
  let measurement: StrataLoadMeasurement | null = await readConfigLoadMeasurement(obj, file);
  const kvDecision = Number.isFinite(context)
    ? decideKvInVram(measurement, { context, kv }, deps.bootTimeMs ?? defaultBootTimeMs())
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
