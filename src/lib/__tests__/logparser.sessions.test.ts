import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { LogParser, type TaskMetrics } from "../logparser";

describe("llama parser source boundaries", () => {
  afterEach(() => vi.useRealTimers());

  it("uses frozen source origin instead of the selected profile", () => {
    const parser = new LogParser();
    parser.setSource({ runtime: "llama", sessionId: "a", profile: "frozen", model: "model-a", version: "v-a" });
    const result = parser.processLine("slot release: id 0 | task 1 | stop processing: n_tokens = 20, truncated = 0");
    expect(result).toMatchObject({ taskId: 1, profile: "frozen", model: "model-a", version: "v-a" });
    parser.stop();
  });

  it("cancels pending completion timers at a session boundary and permits reused IDs", () => {
    vi.useFakeTimers();
    const parser = new LogParser();
    const seen: unknown[] = [];
    parser.on("task", (task) => seen.push(task));
    parser.processLine("slot print_timing: id 0 | task 1 | total time = 100 ms / 10 tokens");
    parser.stop();
    parser.setSource({ runtime: "llama", sessionId: "b", profile: "new" });
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([]);
    parser.processLine("slot release: id 0 | task 1 | stop processing: n_tokens = 20, truncated = 0");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: 1, profile: "new" });
    parser.stop();
  });

  it("replays trailing release and draft facts before flushing timing-only completions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llama-parser-replay-"));
    const parser = new LogParser();
    const seen: TaskMetrics[] = [];
    parser.on("task", (task: TaskMetrics) => seen.push(task));
    try {
      const file = path.join(dir, "server.log");
      await fs.writeFile(file, [
        "slot print_timing: id 0 | task 1 | total time = 100 ms / 10 tokens",
        "slot print_timing: id 0 | task 1 | graphs reused = 3",
        "slot print_timing: id 0 | task 1 | draft acceptance = 0.5 (2 accepted / 4 generated)",
        "slot release: id 0 | task 1 | stop processing: n_tokens = 20, truncated = 1",
        "slot print_timing: id 0 | task 2 | total time = 200 ms / 15 tokens",
      ].join("\n") + "\n");
      await parser.parseExistingFile(file);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        taskId: 1, totalTimeMs: 100, contextSize: 20, truncated: true,
        graphsReused: 3, draftAccepted: 2, draftGenerated: 4,
      });
      expect(seen[1]).toMatchObject({ taskId: 2, totalTimeMs: 200, totalTokens: 15 });
    } finally {
      parser.stop();
      await fs.remove(dir);
    }
  });
});
