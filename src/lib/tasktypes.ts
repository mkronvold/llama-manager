import type { TaskMetrics as LlamaTask } from "./logparser";

export interface TaskSource {
  runtime: "llama" | "strata";
  sessionId: string;
  profile?: string;
  model?: string;
  version?: string;
}

type Measurement = "slotId" | "promptTokens" | "promptTimeMs" | "promptSpeed" |
  "outputTokens" | "evalTimeMs" | "outputSpeed" | "totalTimeMs" | "totalTokens" |
  "graphsReused" | "draftAcceptance" | "draftAccepted" | "draftGenerated" | "contextSize" | "truncated";

export type StoredTask = Omit<LlamaTask, Measurement | "timestamp"> & {
  [K in Measurement]: LlamaTask[K] | null;
} & {
  timestamp: string | null;
  rowId?: number;
  runtime: "llama" | "strata";
  sourceSession: string;
  requestedInput: number | null;
  processedInput: number | null;
  cachedInput: number | null;
  engineOutput: number | null;
  wallTimeMs: number | null;
  finishReason: string | null;
};
