import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideKvInVram,
  parseStrataLoadMeasurement,
  readConfigVramReserve,
  tuneConfiguredStrataConfigs,
  tuneStrataArgs,
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
