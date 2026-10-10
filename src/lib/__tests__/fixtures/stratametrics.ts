// Sanitized stock shape, with synthetic counts and no prompt/response data.
export function metricsFixture(count = 1, epoch: number | null = 1000) {
  return {
    engine: { model: "fixture", max_context: 8192, kv: "int8", spec: 6 },
    live: { state: "idle", queued: 0 },
    totals: { since: epoch, requests: count, prompt_tokens: count * 18, reused: count * 10,
      output_tokens: count * 8, prompt_ms: count * 455.4, decode_ms: count * 380.1 },
    requests_kept: Math.min(count, 500),
    requests: Array.from({ length: Math.min(count, 500) }, () => ({
      time: 1000, duration_s: 0.8, finish: "stop", prompt_total: 18, prompt_tokens: 18,
      reused: 10, output_tokens: 8, engine_generated: 12, prompt_ms: 455.4,
      decode_ms: 380.1, decode_tok_s: 31.6, drafts_offered: 4, drafts_accepted: 3,
    })),
  };
}
