import { describe, expect, it } from "vitest";
import { parseStrataMetrics } from "../stratametrics";

import { metricsFixture } from "./fixtures/stratametrics";

describe("Strata stock metrics", () => {
  it("uses evaluated input, delivered output, engine TG and distinct clocks", () => {
    const metrics = parseStrataMetrics(metricsFixture());
    expect(metrics.requests[0]).toMatchObject({ ordinal: 1, evaluatedInput: 8, requestedInput: 18,
      cachedInput: 10, output: 8, engineOutput: 12, decodeRate: 31.6,
      totalMs: 835.5, wallMs: 800 });
    expect(metrics).toMatchObject({ evaluated: 8, spec: 6, context: 8192 });
  });

  it("reverses newest-first history without sorting or hashing identical records", () => {
    const fixture = metricsFixture(3);
    fixture.requests[0]!.finish = "disconnect";
    const records = parseStrataMetrics(fixture).requests;
    expect(records.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(records.map((r) => r.finish)).toEqual(["stop", "stop", "disconnect"]);
    expect(new Set(records.map((r) => r.timestamp)).size).toBe(1);
  });

  it("maps interrupted prefill to measured processed minus reused, not requested input", () => {
    const fixture = metricsFixture();
    Object.assign(fixture.requests[0]!, { prompt_total: 1000, prompt_tokens: 20, reused: 5,
      output_tokens: 0, engine_generated: 0, decode_ms: 0, decode_tok_s: null, finish: "disconnect" });
    expect(parseStrataMetrics(fixture).requests[0]).toMatchObject({
      requestedInput: 1000, processedInput: 20, evaluatedInput: 15, output: 0, decodeRate: null, finish: "disconnect",
    });
  });

  it("preserves unknown measurements instead of numeric defaults", () => {
    const fixture = metricsFixture();
    Object.assign(fixture.requests[0]!, { reused: null, prompt_ms: null, engine_generated: null,
      decode_tok_s: null, drafts_accepted: null, drafts_offered: null });
    expect(parseStrataMetrics(fixture).requests[0]).toMatchObject({
      evaluatedInput: null, promptMs: null, totalMs: null, decodeRate: null, draftsAccepted: null,
    });
  });

  it("derives TG only from engine count, not delivered output", () => {
    const fixture = metricsFixture();
    Object.assign(fixture.requests[0]!, { decode_tok_s: null, decode_ms: 1000 });
    expect(parseStrataMetrics(fixture).requests[0]?.decodeRate).toBe(12);
  });

  it.each(["reading", "generating", "idle", "unloaded"])("accepts live state %s without inventing slots", (state) => {
    const fixture = metricsFixture();
    fixture.live.state = state;
    expect(parseStrataMetrics(fixture).live).toMatchObject({ state, slots: [], rate: null, parallel: null });
  });

  it("maps only genuinely reported live slots and concurrency", () => {
    const fixture = metricsFixture();
    Object.assign(fixture.live, { parallel: 2, running: 1, slots: [
      { slot: 0, state: "idle", held_tokens: 18 }, { slot: 1, state: "decoding", generated: 4, prompt_tokens: 20, tok_s: 12.5, elapsed_s: 2 },
    ] });
    const live = parseStrataMetrics(fixture).live;
    expect(live.parallel).toBe(2);
    expect(live.slots).toEqual([
      { slot: 0, state: "idle", generated: null, promptTokens: null, rate: null, elapsedSeconds: null, heldTokens: 18 },
      { slot: 1, state: "decoding", generated: 4, promptTokens: 20, rate: 12.5, elapsedSeconds: 2, heldTokens: null },
    ]);
    expect(live.outsideSlots).toBeNull();
  });

  it("maps requests running outside the batch slots", () => {
    const fixture = metricsFixture();
    Object.assign(fixture.live, { state: "reading", prompt_tokens: 26651, parallel: 4, running: 1, outside_slots: 1, waiting: 0,
      slots: [0, 1, 2, 3].map(slot => ({ slot, state: "idle", held_tokens: 0 })) });
    const live = parseStrataMetrics(fixture).live;
    expect(live).toMatchObject({ outsideSlots: 1, promptTokens: 26651, running: 1 });
    Object.assign(fixture.live, { outside_slots: -1 });
    expect(() => parseStrataMetrics(fixture)).toThrow(/outside_slots/);
  });

  it("rejects malformed per-slot rates and elapsed measurements", () => {
    const fixture = metricsFixture();
    Object.assign(fixture.live, { slots: [{ slot: 0, state: "decoding", tok_s: -1 }] });
    expect(() => parseStrataMetrics(fixture)).toThrow(/slot.tok_s/);
    Object.assign(fixture.live, { slots: [{ slot: 0, state: "decoding", elapsed_s: NaN }] });
    expect(() => parseStrataMetrics(fixture)).toThrow(/slot.elapsed_s/);
  });

  it.each([
    { requests_kept: 2 }, { requests: [] }, { totals: { requests: -1 } },
    { totals: { requests: Number.MAX_SAFE_INTEGER + 1 } }, { live: { state: "unknown" } },
    { engine: null },
  ])("rejects inconsistent or malformed snapshots %j", (changes) => {
    expect(() => parseStrataMetrics({ ...metricsFixture(), ...changes })).toThrow();
  });

  it("rejects negative/nonfinite measurements but tolerates one record's inconsistent counters", () => {
    const fixture = metricsFixture();
    // Observed live: a finish=error record reported more reused than processed tokens.
    Object.assign(fixture.requests[0]!, { reused: 19, drafts_accepted: 5, drafts_offered: 2 });
    const request = parseStrataMetrics(fixture).requests[0]!;
    expect(request).toMatchObject({ cachedInput: 19, evaluatedInput: null, draftsAccepted: null, draftsOffered: null });
    fixture.requests[0]!.reused = 0;
    fixture.requests[0]!.decode_ms = NaN;
    expect(() => parseStrataMetrics(fixture)).toThrow(/decode_ms/);
  });
});
