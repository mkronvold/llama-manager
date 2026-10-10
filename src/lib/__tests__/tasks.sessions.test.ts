import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { metricsFixture } from "./fixtures/stratametrics";
import { parseStrataMetrics } from "../stratametrics";
import { migrateTaskDatabase } from "../taskdb";
import type { TaskMetrics as LlamaTask } from "../logparser";

const LEGACY_SCHEMA = `CREATE TABLE tasks (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER UNIQUE, slot_id INTEGER,
  timestamp TEXT, profile TEXT, model TEXT, version TEXT,
  prompt_tokens INTEGER, prompt_time_ms REAL, prompt_speed REAL,
  output_tokens INTEGER, eval_time_ms REAL, output_speed REAL, total_tokens INTEGER,
  total_time_ms REAL, draft_accepted INTEGER, draft_generated INTEGER, context_size INTEGER,
  truncated INTEGER, graphs_reused INTEGER);
  CREATE TABLE stats_cache (key TEXT PRIMARY KEY, value REAL);`;

const LLAMA_TASK: LlamaTask = { taskId: 1, slotId: 0, timestamp: "2026-10-10T01:00:00Z",
  promptTokens: 20, promptTimeMs: 100, promptSpeed: 200, outputTokens: 10, evalTimeMs: 1000,
  outputSpeed: 10, totalTimeMs: 1100, totalTokens: 30, draftAccepted: 0, draftGenerated: 0,
  draftAcceptance: 0, graphsReused: 0, contextSize: 40, truncated: false, profile: "frozen" };

describe("durable task sessions", () => {
  let temp: string;
  let store: import("../tasks").TaskStore;
  let config: import("../config").ConfigData;
  let dbPath: string;
  const source = { runtime: "strata" as const, sessionId: "manager-1", profile: "frozen", version: "strata:fixture" };

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "task-sessions-"));
    vi.stubEnv("XDG_CONFIG_HOME", temp);
    vi.stubEnv("XDG_STATE_HOME", path.join(temp, "state"));
    vi.stubEnv("XDG_DATA_HOME", path.join(temp, "data"));
    vi.resetModules();
    const cfg = await import("../config");
    config = await cfg.loadConfig();
    config.tasksFile = path.join(temp, "tasks.jsonl");
    config.server.logFile = path.join(temp, "missing.log");
    dbPath = cfg.getTasksDb(config);
    const { taskStore } = await import("../tasks");
    store = taskStore;
  });

  afterEach(async () => {
    store.dispose();
    vi.unstubAllEnvs();
    await fs.remove(temp);
  });

  it("backs up WAL data and preserves legacy row IDs, values and history", async () => {
    const old = new Database(dbPath);
    old.pragma("journal_mode=WAL");
    old.exec(LEGACY_SCHEMA);
    old.prepare("INSERT INTO tasks(rowid,task_id,prompt_tokens,prompt_time_ms,output_tokens,eval_time_ms) VALUES (42,1,20,100,10,1000)").run();
    old.prepare("INSERT INTO stats_cache VALUES ('total_count',999)").run();
    old.close();
    await store.init(config);
    expect(store.getRange(0, 10)[0]).toMatchObject({ rowId: 42, taskId: 1, promptTokens: 20, sourceSession: "legacy", engineOutput: 10 });
    expect(store.getStats()).toMatchObject({ count: 1, totalPromptTokens: 20, avgPromptSpeed: 200, avgOutputSpeed: 10 });
    const backups = (await fs.readdir(temp)).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(temp, backups[0]!), { readonly: true });
    expect(backup.prepare("SELECT rowid,task_id FROM tasks").get()).toEqual({ rowid: 42, task_id: 1 });
    backup.close();
    store.setSource({ runtime: "llama", sessionId: "future" });
    store.onTask(LLAMA_TASK);
    expect(store.getTotalCount()).toBe(2);
  });

  it("rolls back schema failures without altering the original table or version", async () => {
    const db = new Database(dbPath);
    db.exec(LEGACY_SCHEMA);
    db.exec("CREATE TABLE task_sources (conflict INTEGER)");
    db.exec("INSERT INTO tasks(task_id) VALUES(7)");
    await expect(migrateTaskDatabase(db, dbPath)).rejects.toThrow();
    expect(db.prepare("SELECT task_id FROM tasks").get()).toEqual({ task_id: 7 });
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("PRAGMA table_info(tasks)").all().some((r) => (r as { name: string }).name === "source_session")).toBe(false);
    db.close();
    expect((await fs.readdir(temp)).some((name) => name.endsWith(".bak"))).toBe(true);
  });

  it("does not migrate when the backup cannot be created", async () => {
    const db = new Database(dbPath);
    db.exec(LEGACY_SCHEMA);
    db.exec("INSERT INTO tasks(task_id) VALUES (4)");
    const backup = vi.spyOn(db, "backup").mockRejectedValue(new Error("backup denied"));
    try {
      await expect(migrateTaskDatabase(db, dbPath)).rejects.toThrow("backup denied");
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect(db.prepare("SELECT task_id FROM tasks").get()).toEqual({ task_id: 4 });
    } finally {
      backup.mockRestore();
      db.close();
    }
  });

  it("keeps future reused llama IDs separate and makes corrections idempotent", async () => {
    await store.init(config);
    store.setSource({ runtime: "llama", sessionId: "one" });
    store.onTask(LLAMA_TASK);
    store.onTask(LLAMA_TASK);
    expect(store.getStats()).toMatchObject({ count: 1, totalOutputTokens: 10 });
    store.onTask({ ...LLAMA_TASK, outputTokens: 12 });
    expect(store.getStats()).toMatchObject({ count: 1, totalOutputTokens: 12 });
    store.setSource({ runtime: "llama", sessionId: "two" });
    store.onTask(LLAMA_TASK);
    expect(store.getStats()).toMatchObject({ count: 2, totalOutputTokens: 22 });
  });

  it("imports identical completions once and uses matching engine/timing denominators", async () => {
    await store.init(config);
    const snapshot = parseStrataMetrics(metricsFixture(2));
    store.ingestStrata(source, snapshot);
    store.ingestStrata(source, snapshot);
    expect(store.getStats()).toMatchObject({ count: 2, totalPromptTokens: 16, totalOutputTokens: 16 });
    expect(store.getStats().avgOutputSpeed).toBeCloseTo(12 * 1000 / 380.1);
    expect(store.getRange(0, 10).map((r) => r.taskId)).toEqual([2, 1]);
    expect(store.getRange(0, 10)[0]).toMatchObject({ slotId: null, contextSize: null, truncated: null, graphsReused: null, wallTimeMs: 800 });
    store.dispose();
    await store.init(config);
    store.ingestStrata(source, snapshot);
    expect(store.getTotalCount()).toBe(2);
  });

  it("persists rollover gaps separately and recovers newer rows without replay inflation", async () => {
    await store.init(config);
    expect(store.ingestStrata(source, parseStrataMetrics(metricsFixture(505)))).toBe(5);
    expect(store.getTotalCount()).toBe(500);
    store.ingestStrata(source, parseStrataMetrics(metricsFixture(1100)));
    expect(store.getHistoryGapCount()).toBe(100);
    expect(store.getTotalCount()).toBe(1000);
    expect(store.getHistoryGaps()).toEqual([
      { sessionId: "manager-1:1000", first: 1, last: 5 },
      { sessionId: "manager-1:1000", first: 506, last: 600 },
    ]);
    store.ingestStrata(source, parseStrataMetrics(metricsFixture(1100)));
    expect(store.getTotalCount()).toBe(1000);
    expect(store.getHistoryGapCount()).toBe(100);
  });

  it("separates new epochs, rejects same-epoch regression and missing epoch", async () => {
    await store.init(config);
    store.ingestStrata(source, parseStrataMetrics(metricsFixture(2)));
    expect(() => store.ingestStrata(source, parseStrataMetrics(metricsFixture(1)))).toThrow(/regressed/);
    store.ingestStrata(source, parseStrataMetrics(metricsFixture(1, 2000)));
    expect(store.getTotalCount()).toBe(3);
    expect(() => store.ingestStrata(source, parseStrataMetrics(metricsFixture(1, null)))).toThrow(/epoch/);
    expect(store.getTotalCount()).toBe(3);
  });

  it("rolls back rows, gaps and watermark on write failure, then safely retries", async () => {
    await store.init(config);
    const db = new Database(dbPath);
    db.exec("CREATE TRIGGER fail_task BEFORE INSERT ON tasks WHEN NEW.task_id=7 BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const snapshot = parseStrataMetrics(metricsFixture(505));
    expect(() => store.ingestStrata(source, snapshot)).toThrow(/injected failure/);
    expect(store.getTotalCount()).toBe(0);
    expect(store.getHistoryGapCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_sources").get()).toEqual({ n: 0 });
    db.exec("DROP TRIGGER fail_task");
    store.ingestStrata(source, snapshot);
    expect(store.getTotalCount()).toBe(500);
    expect(store.getHistoryGapCount()).toBe(5);
    db.close();
  });

  it("counts cancelled measured work but leaves absent rates unknown", async () => {
    await store.init(config);
    const fixture = metricsFixture(2);
    Object.assign(fixture.requests[0]!, { finish: "disconnect", engine_generated: null,
      prompt_ms: null, reused: null, decode_tok_s: null });
    store.ingestStrata(source, parseStrataMetrics(fixture));
    expect(store.getStats()).toMatchObject({ count: 2, totalPromptTokens: 8, totalOutputTokens: 16, promptMeasured: 1, outputMeasured: 1 });
    const tasks = store.getRange(0, 10);
    expect(tasks[0]).toMatchObject({ finishReason: "disconnect", promptTokens: null, totalTimeMs: null, outputSpeed: null });
    expect(store.getStats().avgOutputSpeed).toBeCloseTo(12 * 1000 / 380.1);
  });

  it("replays owned llama archives in their recorded sessions, never as duplicate legacy tasks", async () => {
    await store.init(config);
    const log = path.join(temp, "owned.log");
    await fs.writeFile(log, "");
    store.setSource({ runtime: "llama", sessionId: "one", profile: "first" });
    store.setLogFile(log);
    const line = "slot release: id 0 | task 1 | stop processing: n_tokens = 20, truncated = 0\n";
    await fs.appendFile(log, line);
    store.setSource({ runtime: "llama", sessionId: "two", profile: "second" });
    store.setLogFile(log, Buffer.byteLength(line));
    await fs.appendFile(log, line);
    store.dispose();
    config.server.logFile = log;
    await store.init(config);
    expect(store.getTotalCount()).toBe(2);
    expect(new Set(store.getRange(0, 10).map((t) => t.sourceSession))).toEqual(new Set(["one", "two"]));
    store.dispose();
    await store.init(config);
    expect(store.getTotalCount()).toBe(2);
    expect(store.getRange(0, 10).map((t) => t.profile).sort()).toEqual(["first", "second"]);
  });

  it("keeps wholly unavailable token aggregates and chart points nullable", async () => {
    await store.init(config);
    const fixture = metricsFixture();
    Object.assign(fixture.requests[0]!, { prompt_tokens: null, reused: null, output_tokens: null,
      engine_generated: null, prompt_ms: null, decode_ms: null, decode_tok_s: null, time: Date.now() / 1000 });
    store.ingestStrata(source, parseStrataMetrics(fixture));
    expect(store.getStats()).toMatchObject({ count: 1, totalPromptTokens: null, totalOutputTokens: null,
      avgPromptSpeed: null, avgOutputSpeed: null, inputKnown: 0, outputKnown: 0 });
    expect(store.getTokensOverTime("hour", 1)[0]).toMatchObject({ promptTokens: null, outputTokens: null });
  });
});
