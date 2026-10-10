export interface StrataRequest {
  ordinal: number;
  timestamp: string | null;
  requestedInput: number | null;
  processedInput: number | null;
  cachedInput: number | null;
  evaluatedInput: number | null;
  output: number | null;
  engineOutput: number | null;
  promptMs: number | null;
  decodeMs: number | null;
  decodeRate: number | null;
  totalMs: number | null;
  wallMs: number | null;
  draftsAccepted: number | null;
  draftsOffered: number | null;
  finish: string | null;
}

export interface StrataLive {
  state: string;
  promptRead: number | null;
  promptTotal: number | null;
  generated: number | null;
  rate: number | null;
  promptRate: number | null;
  elapsedSeconds: number | null;
  queued: number | null;
  parallel: number | null;
  running: number | null;
  waiting: number | null;
  slots: { slot: number; state: string; generated: number | null; promptTokens: number | null; rate: number | null; elapsedSeconds: number | null }[];
}

export interface StrataMetrics {
  epoch: number | null;
  count: number;
  kept: number;
  input: number | null;
  cached: number | null;
  evaluated: number | null;
  output: number | null;
  promptMs: number | null;
  decodeMs: number | null;
  draftsAccepted: number | null;
  draftsOffered: number | null;
  model: string | null;
  engineVersion: string | null;
  context: number | null;
  spec: number | null;
  kv: string | null;
  live: StrataLive;
  requests: StrataRequest[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${field}: expected object`);
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string, integer = false): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${field}: expected nonnegative ${integer ? "safe integer" : "number"}`);
  }
  return value;
}

function text(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${field}: expected string`);
  return value;
}

function difference(total: number | null, cached: number | null, field: string): number | null {
  if (total === null || cached === null) return null;
  if (cached > total) throw new Error(`Invalid ${field}: cached exceeds processed input`);
  return total - cached;
}

export function parseStrataMetrics(value: unknown): StrataMetrics {
  const body = object(value, "metrics");
  const totals = object(body.totals, "totals");
  const live = object(body.live, "live");
  const engine = object(body.engine, "engine");
  const count = number(totals.requests, "totals.requests", true);
  const kept = number(body.requests_kept, "requests_kept", true);
  if (count === null || kept === null || !Array.isArray(body.requests) ||
    body.requests.length !== kept || kept !== Math.min(count, 500)) {
    throw new Error("Inconsistent Strata history/count snapshot (requests=all required)");
  }
  const state = text(live.state, "live.state");
  if (!state || !["reading", "generating", "idle", "unloaded"].includes(state)) {
    throw new Error("Invalid live.state");
  }
  const requests = [...body.requests].reverse().map((value, index): StrataRequest => {
    const r = object(value, "request");
    const n = (key: string, integer = false) => number(r[key], `request.${key}`, integer);
    const processedInput = n("prompt_tokens", true), cachedInput = n("reused", true);
    const requestedInput = n("prompt_total", true);
    if (requestedInput !== null && processedInput !== null && processedInput > requestedInput) throw new Error("Processed input exceeds requested input");
    const draftsAccepted = n("drafts_accepted", true), draftsOffered = n("drafts_offered", true);
    if (draftsAccepted !== null && draftsOffered !== null && draftsAccepted > draftsOffered) throw new Error("Accepted drafts exceed offered drafts");
    const promptMs = n("prompt_ms"), decodeMs = n("decode_ms"), engineOutput = n("engine_generated", true);
    const time = n("time");
    const date = time === null ? null : new Date(time * 1000);
    if (date && !Number.isFinite(date.getTime())) throw new Error("Invalid request.time");
    return {
      ordinal: count - kept + index + 1,
      timestamp: date?.toISOString() ?? null,
      requestedInput, processedInput, cachedInput,
      evaluatedInput: difference(processedInput, cachedInput, "request"),
      output: n("output_tokens", true), engineOutput, promptMs, decodeMs,
      decodeRate: n("decode_tok_s") ?? (engineOutput !== null && decodeMs !== null && decodeMs > 0 ? engineOutput * 1000 / decodeMs : null),
      totalMs: promptMs !== null && decodeMs !== null ? promptMs + decodeMs : null,
      wallMs: n("duration_s") === null ? null : n("duration_s")! * 1000,
      draftsAccepted, draftsOffered,
      finish: text(r.finish, "request.finish"),
    };
  });
  const input = number(totals.prompt_tokens, "totals.prompt_tokens", true);
  const cached = number(totals.reused, "totals.reused", true);
  if (live.slots !== undefined && !Array.isArray(live.slots)) throw new Error("Invalid live.slots");
  const slots = (Array.isArray(live.slots) ? live.slots : []).map((value) => {
    const slot = object(value, "live.slot");
    const id = number(slot.slot, "slot.slot", true), state = text(slot.state, "slot.state");
    if (id === null || !state || !["idle", "reading", "decoding", "generating"].includes(state)) throw new Error("Invalid live slot");
    return { slot: id, state, generated: number(slot.generated, "slot.generated", true),
      promptTokens: number(slot.prompt_tokens, "slot.prompt_tokens", true),
      rate: number(slot.tok_s, "slot.tok_s"), elapsedSeconds: number(slot.elapsed_s, "slot.elapsed_s") };
  });
  if (new Set(slots.map((s) => s.slot)).size !== slots.length) throw new Error("Duplicate live slot");
  return {
    epoch: number(totals.since, "totals.since"), count, kept, input, cached,
    evaluated: difference(input, cached, "totals"),
    output: number(totals.output_tokens, "totals.output_tokens", true),
    promptMs: number(totals.prompt_ms, "totals.prompt_ms"), decodeMs: number(totals.decode_ms, "totals.decode_ms"),
    draftsAccepted: number(totals.drafts_accepted, "totals.drafts_accepted", true),
    draftsOffered: number(totals.drafts_offered, "totals.drafts_offered", true),
    model: text(engine.model, "engine.model"), engineVersion: text(engine.version, "engine.version"),
    context: number(engine.max_context, "engine.max_context", true),
    spec: number(engine.spec, "engine.spec", true), kv: text(engine.kv, "engine.kv"),
    live: { state, slots, promptRead: number(live.prompt_read, "live.prompt_read", true),
      promptTotal: number(live.prompt_total, "live.prompt_total", true),
      generated: number(live.generated, "live.generated", true), rate: number(live.tok_s, "live.tok_s"),
      promptRate: number(live.prefill_tok_s_mean, "live.prefill_tok_s_mean"),
      elapsedSeconds: number(live.elapsed_s, "live.elapsed_s"), queued: number(live.queued, "live.queued", true),
      parallel: number(live.parallel, "live.parallel", true), running: number(live.running, "live.running", true),
      waiting: number(live.waiting, "live.waiting", true) },
    requests,
  };
}

export interface StrataMetricsView {
  snapshot: StrataMetrics | null;
  receivedAt: number | null;
  error: string | null;
  historyError: string | null;
  missingRequests: number;
}
