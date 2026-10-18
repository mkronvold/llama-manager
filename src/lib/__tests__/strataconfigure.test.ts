import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStrataConfigOverrides,
  applyStrataOverrides,
  decideKvInVram,
  parseStrataLoadMeasurement,
  readConfigVramReserve,
  strataBatchSlots,
  strataOverrideWarnings,
  tuneConfiguredStrataConfigs,
  tuneStrataArgs,
  writeStrataLaunchConfig,
  type KvDecision,
} from "../strataconfigure";

const START = "[strata] 2026-10-16 17:40:45 engine started: C:\\S\\engine\\strata.exe --serve --pack C:\\S\\p "
  + "--expert-cache auto --prefill auto:32768 --max-context 204800 --kv int8 --kv-resident 32768 --resident-budget-gib 55";

function load(opts: { slots?: number; free?: number; streamed?: boolean; up?: boolean; start?: string } = {}): string {
  return [
    opts.start ?? START,
    "strata generate: profile C:\\S\\data\\expert-profile.bin: 24576 ranked pairs, built for 24576 slots",
    ...(opts.streamed === false ? [] : [
      "strata generate: KV streaming: 32768 of 204800 cells per QSA layer in VRAM, the K/V in 2.42 GiB of pinned RAM",
    ]),
    "strata generate: expert cache auto: 88.72 GiB free, 1212 MiB reserved (+218 MiB for the draft head) -> 24576 slots",
    `strata generate: expert cache ${opts.slots ?? 24576} slots, 55.43 GiB of VRAM; policy is`,
    ...(opts.up === false ? [] : ["strata generate: session is up (engine 0.1.40)"]),
    `strata serve: ${opts.free ?? 29838} MiB of VRAM free with everything loaded`
      + ((opts.free ?? 29838) === 0 ? " - LOW: requests may stall; add --vram-reserve-mib 1724 to the config's args" : ""),
    "strata serve: KV streaming: 95.54% of 161795448 block reads hit VRAM, 29039.2 MiB read from RAM",
  ].join("\n");
}

const BOOT = new Date(2026, 9, 16, 17, 1, 47).getTime();
const TARGET = { context: 262144, kv: "int8" };

describe("parseStrataLoadMeasurement", () => {
  it("parses the latest completed engine load", () => {
    const older = load({ slots: 17771, free: 0, start: START.replace("17:40:45", "15:08:25") });
    const m = parseStrataLoadMeasurement(`${older}\n${load()}\n`);
    expect(m).toMatchObject({
      context: 204800, kv: "int8", kvResidentCells: 32768, profilePairs: 24576, expertSlots: 24576, vramFreeMib: 29838,
    });
    expect(m?.startedAt.getTime()).toBe(new Date(2026, 9, 16, 17, 40, 45).getTime());
  });

  it("reads an unstreamed load's context from the command line", () => {
    const m = parseStrataLoadMeasurement(load({ streamed: false }));
    expect(m).toMatchObject({ context: 204800, kvResidentCells: null });
  });

  it("returns null when the latest load never finished", () => {
    expect(parseStrataLoadMeasurement(`${load()}\n${START}\nstrata generate: profile x: 24576 ranked pairs`)).toBeNull();
    expect(parseStrataLoadMeasurement(load({ up: false }))).toBeNull();
    expect(parseStrataLoadMeasurement("")).toBeNull();
  });
});

describe("decideKvInVram", () => {
  it("keeps the KV cache in VRAM when all experts fit with room for it", () => {
    const d = decideKvInVram(parseStrataLoadMeasurement(load()), TARGET, BOOT);
    expect(d.keepInVram).toBe(true);
    expect(d.reason).toMatch(/all 24576 experts with 29838 MiB/);
  });

  it("streams when the GPU cache did not hold every expert (8 GB split)", () => {
    const d = decideKvInVram(parseStrataLoadMeasurement(load({ slots: 17771, free: 0 })), TARGET, BOOT);
    expect(d).toEqual({ keepInVram: false, reason: "the last load held 17771 of 24576 experts in VRAM" });
  });

  it("streams when all experts fit but no VRAM is left for the KV cache", () => {
    const d = decideKvInVram(parseStrataLoadMeasurement(load({ free: 0 })), TARGET, BOOT);
    expect(d.keepInVram).toBe(false);
    expect(d.reason).toMatch(/needs \d+ MiB more VRAM; the last load had 0 MiB free/);
  });

  it("ignores a load from before the latest restart and a missing measurement", () => {
    const m = parseStrataLoadMeasurement(load());
    expect(decideKvInVram(m, TARGET, BOOT + 24 * 3600_000).keepInVram).toBe(false);
    expect(decideKvInVram(null, TARGET, BOOT).reason).toMatch(/no completed load/);
  });

  it("needs no extra VRAM when the measured load already kept a larger KV cache in VRAM", () => {
    const d = decideKvInVram(parseStrataLoadMeasurement(load({ streamed: false, free: 2048 })), { context: 131072, kv: "int8" }, BOOT);
    expect(d.keepInVram).toBe(true);
  });
});

describe("tuneStrataArgs", () => {
  const yes: KvDecision = { keepInVram: true, reason: "measured" };
  const no: KvDecision = { keepInVram: false, reason: "not measured" };
  const base = ["--pack", "p", "--prefill", "auto", "--max-context", "262144", "--kv", "int8", "--kv-resident", "32768"];

  it("applies prefill, conversation cache and KV-in-VRAM on a large-RAM PC", () => {
    const r = tuneStrataArgs(base, { ramGiB: 95.6, kv: yes });
    expect(r.args).toEqual(["--pack", "p", "--prefill", "auto:32768", "--max-context", "262144", "--kv", "int8",
      "--conversation-cache-mib", "8192"]);
    expect(r.changes).toHaveLength(3);
  });

  it("keeps streaming and setup's prefill on a small-RAM PC", () => {
    const r = tuneStrataArgs(base, { ramGiB: 48, kv: no });
    expect(r.args).toEqual(base);
    expect(r.changes).toEqual(["KV streaming kept: not measured"]);
  });

  it("adds prefill but not the conversation cache between the thresholds", () => {
    const r = tuneStrataArgs(base, { ramGiB: 72, kv: no });
    expect(r.args).toContain("auto:32768");
    expect(r.args).not.toContain("--conversation-cache-mib");
  });

  it("is idempotent and keeps explicit choices", () => {
    const tuned = ["--prefill", "auto:16384", "--conversation-cache-mib", "4096"];
    expect(tuneStrataArgs(tuned, { ramGiB: 120, kv: yes })).toEqual({ args: tuned, changes: [] });
  });
});

describe("config files", () => {
  let temp: string;
  beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "strata-tune-")); });
  afterEach(async () => { await fs.remove(temp); });

  it("tunes only configs written by the run and preserves other keys", async () => {
    const cfg = { exe: "strata.exe", args: ["--prefill", "auto", "--max-context", "262144", "--kv-resident", "32768"],
      cwd: temp, log: path.join(temp, "a.log"), lib_dirs: ["x"], port: 8080 };
    const fresh = path.join(temp, "strata-a.json");
    const old = path.join(temp, "strata-b.json");
    await fs.writeJson(fresh, cfg);
    await fs.writeJson(old, cfg);
    const past = new Date(BOOT - 60_000);
    const during = new Date(BOOT + 60_000);
    await fs.utimes(old, past, past);
    await fs.utimes(fresh, during, during);
    await fs.writeFile(cfg.log, load());

    const results = await tuneConfiguredStrataConfigs([fresh, old], BOOT, { ramGiB: 95.6, bootTimeMs: BOOT });
    expect(results.map((r) => r.file)).toEqual([fresh]);
    const tuned = await fs.readJson(fresh);
    expect(tuned.args).toEqual(["--prefill", "auto:32768", "--max-context", "262144", "--conversation-cache-mib", "8192"]);
    expect(Object.keys(tuned)).toEqual(Object.keys(cfg));
    expect(tuned.lib_dirs).toEqual(["x"]);
    expect((await fs.readJson(old)).args).toEqual(cfg.args);
  });

  it("reads an existing config's VRAM reserve", async () => {
    const file = path.join(temp, "c.json");
    await fs.writeJson(file, { args: ["--vram-reserve-mib", "1212"] });
    expect(await readConfigVramReserve(file)).toBe(1212);
    expect(await readConfigVramReserve(path.join(temp, "missing.json"))).toBeNull();
    expect(await readConfigVramReserve(null)).toBeNull();
  });
});

describe("profile engine overrides", () => {
  let temp: string;
  beforeEach(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "strata-override-")); });
  afterEach(async () => { await fs.remove(temp); });
  const ARGS = ["--pack", "p", "--prefill", "auto", "--max-context", "204800", "--kv", "int8", "--kv-resident", "32768"];

  it("applies context, KV streaming and prefill without touching other args", () => {
    expect(applyStrataOverrides(ARGS, undefined)).toEqual(ARGS);
    expect(applyStrataOverrides(ARGS, { maxContext: 262144, kvStreaming: "off", prefill: "auto:32768" }))
      .toEqual(["--pack", "p", "--prefill", "auto:32768", "--max-context", "262144", "--kv", "int8"]);
    expect(applyStrataOverrides(ARGS, { kvStreaming: "on" })).toEqual(ARGS);
    expect(applyStrataOverrides(ARGS, { kvStreaming: "on", kvResidentCells: 65536 }).slice(-2)).toEqual(["--kv-resident", "65536"]);
    expect(applyStrataOverrides(["--kv", "int8"], { kvStreaming: "on" })).toEqual(["--kv", "int8", "--kv-resident", "32768"]);
    expect(applyStrataOverrides(["--kv", "int8"], { kvResidentCells: 40960 })).toEqual(["--kv", "int8"]);
    expect(applyStrataOverrides(["--kv", "int8"], { prefill: "auto:16384" })).toEqual(["--kv", "int8", "--prefill", "auto:16384"]);
  });

  it("applies batch slots and batch MTP", () => {
    expect(applyStrataOverrides(["--batch", "2", "--kv", "int8"], { parallel: 4 })).toEqual(["--kv", "int8"]);
    expect(applyStrataOverrides(["--kv", "int8"], { batchMtp: "on" })).toEqual(["--kv", "int8", "--batch-mtp"]);
    expect(applyStrataOverrides(["--batch-mtp", "--kv", "int8"], { batchMtp: "on" })).toEqual(["--batch-mtp", "--kv", "int8"]);
    expect(applyStrataOverrides(["--batch-mtp", "--kv", "int8"], { batchMtp: "off" })).toEqual(["--kv", "int8"]);
    const cfg = { args: ["--kv", "int8"], parallel: 2, port: 1 };
    expect(applyStrataConfigOverrides(cfg, { parallel: 4 })).toEqual({ ...cfg, parallel: 4 });
    expect(applyStrataConfigOverrides(cfg, { parallel: 1 })).toEqual({ args: ["--kv", "int8"], port: 1 });
    expect(applyStrataConfigOverrides(cfg, { prefill: "auto" })).toEqual({ ...cfg, args: ["--kv", "int8", "--prefill", "auto"] });
    expect(strataBatchSlots(["--slots", "3"], 2)).toBe(3);
    expect(strataBatchSlots([], 4)).toBe(4);
    expect(strataBatchSlots([], undefined)).toBe(1);
  });

  it("warns when batch slots would shrink the expert cache or batch MTP has no slots", () => {
    const roomy = parseStrataLoadMeasurement(load({ free: 29838 }));
    const tight = parseStrataLoadMeasurement(load({ free: 4000 }));
    expect(strataOverrideWarnings(ARGS, { parallel: 4 }, roomy, BOOT)).toEqual([]);
    expect(strataOverrideWarnings(ARGS, { parallel: 4 }, tight, BOOT)[0]).toMatch(/4 batch slots .* expert cache will shrink/);
    expect(strataOverrideWarnings(ARGS, { parallel: 4 }, null, BOOT)[0]).toMatch(/no load since boot/);
    expect(strataOverrideWarnings(ARGS, { batchMtp: "on" }, roomy, BOOT)).toEqual(["batch MTP does nothing without parallel 2 or more"]);
    expect(strataOverrideWarnings(ARGS, { batchMtp: "on" }, roomy, BOOT, 4)).toEqual([]);
  });

  it("warns when the whole KV cache may not fit or streaming covers the whole context", () => {
    const measured = parseStrataLoadMeasurement(load({ free: 0 }));
    const fits = parseStrataLoadMeasurement(load({ free: 29838 }));
    expect(strataOverrideWarnings(ARGS, undefined, null, BOOT)).toEqual([]);
    expect(strataOverrideWarnings(ARGS, { prefill: "auto:32768" }, null, BOOT)).toEqual([]);
    expect(strataOverrideWarnings(ARGS, { kvStreaming: "off" }, null, BOOT)[0]).toMatch(/may not fit: no completed load/);
    expect(strataOverrideWarnings(ARGS, { kvStreaming: "off" }, measured, BOOT)[0]).toMatch(/may not fit/);
    expect(strataOverrideWarnings(ARGS, { kvStreaming: "off", maxContext: 32768 }, fits, BOOT)).toEqual([]);
    expect(strataOverrideWarnings(ARGS, { maxContext: 32768 }, fits, BOOT)[0]).toMatch(/streams nothing/);
  });

  it("writes a derived launch config only when overrides change the args", async () => {
    const source = path.join(temp, "strata-x.json");
    const cfg = { cwd: "C:\\S", args: ARGS, port: 8080, log: "engine.log" };
    await fs.writeJson(source, cfg);
    const dir = path.join(temp, "launch");
    await fs.outputJson(path.join(dir, "old.json"), {});
    expect(await writeStrataLaunchConfig(source, undefined, dir, "s1")).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await writeStrataLaunchConfig(source, { kvStreaming: "on" }, dir, "s2")).toBeNull();
    const file = await writeStrataLaunchConfig(source, { maxContext: 262144 }, dir, "s3");
    expect(file).toBe(path.join(dir, "s3.json"));
    const derived = await fs.readJson(file!);
    expect(derived).toEqual({ ...cfg, args: applyStrataOverrides(ARGS, { maxContext: 262144 }) });
    expect(await fs.readJson(source)).toEqual(cfg);
    expect(await fs.readdir(dir)).toEqual(["s3.json"]);
    const slots = await writeStrataLaunchConfig(source, { parallel: 4, batchMtp: "on" }, dir, "s4");
    expect(await fs.readJson(slots!)).toEqual({ ...cfg, args: [...ARGS, "--batch-mtp"], parallel: 4 });
    expect(await writeStrataLaunchConfig(source, { parallel: 1 }, dir, "s5")).toBeNull();
  });
});
