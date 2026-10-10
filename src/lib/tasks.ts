import fs from "fs-extra";
import path from "path";
import Database from "better-sqlite3";
import { ConfigData, getTasksFile, getTasksDb, getLogsDir } from "./config";

function findLatestLogFile(config: ConfigData): string | null {
  if (config.server.logFile) return config.server.logFile;
  const logsDir = getLogsDir();
  if (!fs.pathExistsSync(logsDir)) return null;
  const files = fs.readdirSync(logsDir)
    .filter((f: string) => /^server\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return path.join(logsDir, files[files.length - 1]);
}
import { type TaskMetrics as LlamaTask, logParser } from "./logparser";
import type { StoredTask as TaskMetrics, TaskSource } from "./tasktypes";
import type { StrataMetrics } from "./stratametrics";
import { migrateTaskDatabase } from "./taskdb";
export type { StoredTask as TaskMetrics } from "./tasktypes";
import { EventEmitter } from "events";

function logPathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface TaskFilter {
  slotId?: number;
  dateFrom?: Date;
  dateTo?: Date;
  minOutputTokens?: number;
  maxOutputTokens?: number;
  minSpeed?: number;
  maxSpeed?: number;
  taskId?: number;
}

export type TaskSortField = "taskId" | "timestamp" | "slotId" | "promptSpeed" | "outputSpeed" | "totalTimeMs" | "promptTokens" | "outputTokens";
export type TaskSortDir = "asc" | "desc";
export type TimeBucket = "hour" | "day";

export interface ChartDataPoint {
  label: string;
  value: number;
}

export interface TokensDataPoint {
  label: string;
  promptTokens: number | null;
  outputTokens: number | null;
}

const SORT_FIELD_MAP: Record<TaskSortField, string> = {
  taskId: "task_id",
  timestamp: "timestamp",
  slotId: "slot_id",
  promptSpeed: "prompt_speed",
  outputSpeed: "output_speed",
  totalTimeMs: "total_time_ms",
  promptTokens: "prompt_tokens",
  outputTokens: "output_tokens",
};

export class TaskStore extends EventEmitter {
  private db: Database.Database | null = null;
  private config: ConfigData | null = null;
  private stopTailer: (() => void) | null = null;
  private source: TaskSource = { runtime: "llama", sessionId: "legacy" };

  private stmts = {
    insertTask: null as Database.Statement | null,
    upsertStats: null as Database.Statement | null,
    getCache: null as Database.Statement | null,
  };

  private getStmts() {
    if (this.stmts.insertTask) return this.stmts;
    this.stmts.insertTask = this.db!.prepare(`
      INSERT INTO tasks (
        task_id, slot_id, timestamp, profile, model, version,
        prompt_tokens, prompt_time_ms, prompt_speed,
        output_tokens, eval_time_ms, output_speed,
        total_tokens, total_time_ms,
        draft_accepted, draft_generated,
        context_size, truncated, graphs_reused,
        runtime, source_session, requested_input, processed_input, cached_input,
        engine_output, wall_time_ms, finish_reason
      ) VALUES (${Array(27).fill("?").join(",")})
      ON CONFLICT(runtime, source_session, task_id) DO UPDATE SET
        slot_id=excluded.slot_id, timestamp=excluded.timestamp,
        profile=excluded.profile, model=excluded.model, version=excluded.version,
        prompt_tokens=excluded.prompt_tokens, prompt_time_ms=excluded.prompt_time_ms,
        prompt_speed=excluded.prompt_speed, output_tokens=excluded.output_tokens,
        eval_time_ms=excluded.eval_time_ms, output_speed=excluded.output_speed,
        total_tokens=excluded.total_tokens, total_time_ms=excluded.total_time_ms,
        draft_accepted=excluded.draft_accepted, draft_generated=excluded.draft_generated,
        context_size=excluded.context_size, truncated=excluded.truncated, graphs_reused=excluded.graphs_reused,
        requested_input=excluded.requested_input, processed_input=excluded.processed_input,
        cached_input=excluded.cached_input, engine_output=excluded.engine_output,
        wall_time_ms=excluded.wall_time_ms, finish_reason=excluded.finish_reason
    `);
    this.stmts.upsertStats = this.db!.prepare("INSERT OR REPLACE INTO stats_cache (key, value) VALUES (?, ?)");
    this.stmts.getCache = this.db!.prepare("SELECT value FROM stats_cache WHERE key = ?");
    return this.stmts;
  }

  async init(config: ConfigData) {
    this.config = config;
    const dbPath = getTasksDb(config);
    await fs.ensureDir(path.dirname(dbPath));

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    try {
      await migrateTaskDatabase(this.db, dbPath);
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
    this.rebuildStats();
    this.migrateJsonl(getTasksFile(config));
    this.getStmts();

    this.setSource({ runtime: "llama", sessionId: "legacy" });
    logParser.setConfig(config);

    const latestLog = findLatestLogFile(config);
    if (latestLog) {
      const owners = this.db.prepare(`SELECT session_id,log_start,profile,model,version
        FROM task_log_sources WHERE log_path=? ORDER BY log_start,recorded_at`)
        .all(logPathKey(latestLog)) as { session_id: string; log_start: number; profile: string | null; model: string | null; version: string | null }[];
      if (owners.length) {
        for (let i = 0; i < owners.length; i++) {
          const owner = owners[i]!;
          this.setSource({ runtime: "llama", sessionId: owner.session_id,
            profile: owner.profile ?? undefined, model: owner.model ?? undefined, version: owner.version ?? undefined });
          await logParser.parseExistingFile(latestLog, owner.log_start, owners[i + 1]?.log_start);
        }
      } else {
        await logParser.parseExistingFile(latestLog);
      }
    }

    this.emit("updated");
  }

  setSource(source: TaskSource): void {
    this.stopTailer?.();
    this.stopTailer = null;
    logParser.stop();
    this.source = { ...source };
    logParser.setSource(source);
    logParser.seedCompleted(this.getAllTaskIds());
  }

  setLogFile(logFile: string, startOffset = 0) {
    if (this.stopTailer) {
      this.stopTailer();
    }
    if (this.db && this.source.runtime === "llama" && this.source.sessionId !== "legacy") {
      this.db.prepare("INSERT OR IGNORE INTO task_log_sources VALUES (?,?,?,?,?,?,?)")
        .run(this.source.sessionId, logPathKey(logFile), startOffset, Date.now(),
          this.source.profile ?? null, this.source.model ?? null, this.source.version ?? null);
    }
    this.stopTailer = logParser.startFileTailer(logFile, startOffset);
  }

  private migrateJsonl(jsonlPath: string) {
    if (!this.db) return;

    if (!fs.pathExistsSync(jsonlPath)) return;

    const existing = this.db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number };
    if (existing.cnt > 0) {
      fs.removeSync(jsonlPath);
      return;
    }

    const content = fs.readFileSync(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      fs.removeSync(jsonlPath);
      return;
    }

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO tasks (
        task_id, slot_id, timestamp, profile, model, version,
        prompt_tokens, prompt_time_ms, prompt_speed,
        output_tokens, eval_time_ms, output_speed,
        total_tokens, total_time_ms,
        draft_accepted, draft_generated,
        context_size, truncated, graphs_reused, engine_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ins = this.db.transaction(() => {
      for (const line of lines) {
        const t = JSON.parse(line) as LlamaTask;
        insert.run(
          t.taskId, t.slotId, t.timestamp,
          t.profile ?? null, t.model ?? null, t.version ?? null,
          t.promptTokens, t.promptTimeMs, t.promptSpeed,
          t.outputTokens, t.evalTimeMs, t.outputSpeed,
          t.totalTokens, t.totalTimeMs,
          t.draftAccepted ?? 0, t.draftGenerated ?? 0,
          t.contextSize, t.truncated ? 1 : 0, t.graphsReused ?? 0, t.outputTokens,
        );
      }
    });

    ins();
    this.rebuildStats();
    fs.removeSync(jsonlPath);
  }

  private rebuildStats() {
    if (!this.db) return;
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as cnt,
        COALESCE(SUM(prompt_tokens), 0) as pt,
        COALESCE(SUM(prompt_time_ms), 0) as ptm,
        COALESCE(SUM(output_tokens), 0) as ot,
        COALESCE(SUM(eval_time_ms), 0) as etm,
        COALESCE(SUM(draft_accepted), 0) as da,
        COALESCE(SUM(draft_generated), 0) as dg
      FROM tasks
    `).get() as { cnt: number; pt: number; ptm: number; ot: number; etm: number; da: number; dg: number };

    const upsert = this.db.prepare("INSERT OR REPLACE INTO stats_cache (key, value) VALUES (?, ?)");
    upsert.run("total_count", row.cnt);
    upsert.run("total_prompt_tokens", row.pt);
    upsert.run("total_prompt_time_ms", row.ptm);
    upsert.run("total_output_tokens", row.ot);
    upsert.run("total_eval_time_ms", row.etm);
    upsert.run("total_draft_accepted", row.da);
    upsert.run("total_draft_generated", row.dg);
  }

  private getAllTaskIds(): number[] {
    if (!this.db) return [];
    const rows = this.db.prepare("SELECT task_id FROM tasks WHERE runtime=? AND source_session=?")
      .all(this.source.runtime, this.source.sessionId) as { task_id: number }[];
    return rows.map(r => r.task_id);
  }

  private insertTask(task: TaskMetrics): void {
    this.getStmts().insertTask!.run(
      task.taskId, task.slotId, task.timestamp,
      task.profile ?? null, task.model ?? null, task.version ?? null,
      task.promptTokens, task.promptTimeMs, task.promptSpeed,
      task.outputTokens, task.evalTimeMs, task.outputSpeed, task.totalTokens, task.totalTimeMs,
      task.draftAccepted, task.draftGenerated, task.contextSize,
      task.truncated === null ? null : task.truncated ? 1 : 0, task.graphsReused,
      task.runtime, task.sourceSession, task.requestedInput, task.processedInput, task.cachedInput,
      task.engineOutput, task.wallTimeMs, task.finishReason,
    );
  }

  onTask(task: LlamaTask) {
    if (!this.db || this.source.runtime !== "llama") return;
    const stored: TaskMetrics = { ...task, runtime: "llama", sourceSession: this.source.sessionId,
      requestedInput: null, processedInput: null, cachedInput: null,
      engineOutput: task.outputTokens, wallTimeMs: null, finishReason: null };
    this.db.transaction(() => { this.insertTask(stored); this.rebuildStats(); })();
    this.emit("updated");
  }

  ingestStrata(source: TaskSource, snapshot: StrataMetrics): number {
    if (!this.db) throw new Error("Tasks database is not ready");
    if (snapshot.epoch === null) throw new Error("Strata history epoch is unavailable; durable recovery is paused");
    const sessionId = `${source.sessionId}:${snapshot.epoch}`;
    const watermark = this.db.prepare("SELECT watermark FROM task_sources WHERE runtime='strata' AND session_id=?")
      .get(sessionId) as { watermark: number } | undefined;
    const previous = watermark?.watermark ?? 0;
    if (snapshot.count < previous) throw new Error("Strata completion counter regressed within the same epoch");
    if (watermark && snapshot.count === previous) return this.getHistoryGapCount(source.sessionId);
    let inserted = 0;
    this.db.transaction(() => {
      const oldest = snapshot.count - snapshot.kept + 1;
      if (oldest > previous + 1) {
        this.db!.prepare("INSERT OR IGNORE INTO task_history_gaps VALUES (?,?,?)")
          .run(sessionId, previous + 1, oldest - 1);
      }
      for (const r of snapshot.requests) {
        if (r.ordinal <= previous) continue;
        this.insertTask({
          taskId: r.ordinal, timestamp: r.timestamp, slotId: null,
          runtime: "strata", sourceSession: sessionId,
          profile: source.profile, version: source.version, model: snapshot.model ?? source.model,
          promptTokens: r.evaluatedInput, promptTimeMs: r.promptMs,
          promptSpeed: r.evaluatedInput !== null && r.promptMs !== null && r.promptMs > 0 ? r.evaluatedInput * 1000 / r.promptMs : null,
          outputTokens: r.output, evalTimeMs: r.decodeMs, outputSpeed: r.decodeRate,
          totalTimeMs: r.totalMs, totalTokens: r.evaluatedInput !== null && r.output !== null ? r.evaluatedInput + r.output : null,
          draftAccepted: r.draftsAccepted, draftGenerated: r.draftsOffered,
          draftAcceptance: r.draftsAccepted !== null && r.draftsOffered !== null && r.draftsOffered > 0 ? r.draftsAccepted / r.draftsOffered : null,
          contextSize: null, truncated: null, graphsReused: null,
          requestedInput: r.requestedInput, processedInput: r.processedInput, cachedInput: r.cachedInput,
          engineOutput: r.engineOutput, wallTimeMs: r.wallMs, finishReason: r.finish,
        });
        inserted++;
      }
      this.db!.prepare("INSERT INTO task_sources VALUES ('strata',?,?) ON CONFLICT(runtime,session_id) DO UPDATE SET watermark=excluded.watermark")
        .run(sessionId, snapshot.count);
      this.rebuildStats();
    })();
    if (inserted || snapshot.count > previous) this.emit("updated");
    return this.getHistoryGapCount(source.sessionId);
  }

  getHistoryGapCount(managerSession?: string): number {
    if (!this.db) return 0;
    const rows = this.db.prepare("SELECT session_id,first_ordinal,last_ordinal FROM task_history_gaps")
      .all() as { session_id: string; first_ordinal: number; last_ordinal: number }[];
    return rows.filter((r) => !managerSession || r.session_id.startsWith(`${managerSession}:`))
      .reduce((sum, r) => sum + r.last_ordinal - r.first_ordinal + 1, 0);
  }

  getHistoryGaps(): { sessionId: string; first: number; last: number }[] {
    if (!this.db) return [];
    return this.db.prepare("SELECT session_id AS sessionId,first_ordinal AS first,last_ordinal AS last FROM task_history_gaps")
      .all() as { sessionId: string; first: number; last: number }[];
  }

  getTotalCount(filter?: TaskFilter): number {
    if (!this.db) return 0;
    const { sql, params } = this.buildFilter(filter);
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM tasks ${sql}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  getRange(offset: number, limit: number, filter?: TaskFilter, sortField: TaskSortField = "timestamp", sortDir: TaskSortDir = "desc"): TaskMetrics[] {
    if (!this.db) return [];
    const { sql, params } = this.buildFilter(filter);
    const col = SORT_FIELD_MAP[sortField];
    const dir = sortDir.toUpperCase();
    const query = `SELECT * FROM tasks ${sql} ORDER BY ${col} ${dir}, rowid ${dir} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(query).all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map(r => this.rowToTask(r));
  }

  getStats(filter?: TaskFilter) {
    if (!this.db) {
      return { avgPromptSpeed: null, avgOutputSpeed: null, totalTokens: 0, totalPromptTokens: 0, totalOutputTokens: 0, avgDraftAcceptance: null, count: 0, promptMeasured: 0, outputMeasured: 0, inputKnown: 0, outputKnown: 0 };
    }

    const { sql, params } = this.buildFilter(filter);
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as cnt,
        SUM(prompt_tokens) as pt, COUNT(prompt_tokens) as input_known,
        SUM(output_tokens) as ot, COUNT(output_tokens) as output_known,
        SUM(CASE WHEN prompt_tokens IS NOT NULL AND prompt_time_ms > 0 THEN prompt_tokens END) as rate_pt,
        SUM(CASE WHEN prompt_tokens IS NOT NULL AND prompt_time_ms > 0 THEN prompt_time_ms END) as ptm,
        COUNT(CASE WHEN prompt_tokens IS NOT NULL AND prompt_time_ms > 0 THEN 1 END) as pc,
        SUM(CASE WHEN engine_output IS NOT NULL AND eval_time_ms > 0 THEN engine_output END) as rate_ot,
        SUM(CASE WHEN engine_output IS NOT NULL AND eval_time_ms > 0 THEN eval_time_ms END) as etm,
        COUNT(CASE WHEN engine_output IS NOT NULL AND eval_time_ms > 0 THEN 1 END) as oc,
        SUM(CASE WHEN draft_accepted IS NOT NULL AND draft_generated IS NOT NULL THEN draft_accepted END) as da,
        SUM(CASE WHEN draft_accepted IS NOT NULL AND draft_generated IS NOT NULL THEN draft_generated END) as dg
      FROM tasks ${sql}
    `).get(...params) as { cnt: number; pt: number | null; ptm: number | null; ot: number | null; etm: number | null; da: number | null; dg: number | null; rate_pt: number | null; rate_ot: number | null; pc: number; oc: number; input_known: number; output_known: number };

    const avgPromptSpeed = row.ptm !== null && row.ptm > 0 && row.rate_pt !== null ? row.rate_pt * 1000 / row.ptm : null;
    const avgOutputSpeed = row.etm !== null && row.etm > 0 && row.rate_ot !== null ? row.rate_ot * 1000 / row.etm : null;
    const avgDraftAcceptance = row.dg !== null && row.dg > 0 && row.da !== null ? row.da / row.dg : null;

    return {
      avgPromptSpeed,
      avgOutputSpeed,
      totalTokens: row.cnt === 0 ? 0 : row.pt !== null && row.ot !== null ? row.pt + row.ot : null,
      totalPromptTokens: row.cnt === 0 ? 0 : row.pt,
      totalOutputTokens: row.cnt === 0 ? 0 : row.ot,
      avgDraftAcceptance,
      count: row.cnt,
      promptMeasured: row.pc,
      outputMeasured: row.oc,
      inputKnown: row.input_known,
      outputKnown: row.output_known,
    };
  }

  private buildFilter(filter?: TaskFilter): { sql: string; params: unknown[] } {
    if (!filter) return { sql: "", params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.slotId !== undefined) {
      conditions.push("slot_id = ?");
      params.push(filter.slotId);
    }
    if (filter.dateFrom) {
      conditions.push("timestamp >= ?");
      params.push(filter.dateFrom.toISOString());
    }
    if (filter.dateTo) {
      conditions.push("timestamp <= ?");
      params.push(filter.dateTo.toISOString());
    }
    if (filter.minOutputTokens !== undefined) {
      conditions.push("output_tokens >= ?");
      params.push(filter.minOutputTokens);
    }
    if (filter.maxOutputTokens !== undefined) {
      conditions.push("output_tokens <= ?");
      params.push(filter.maxOutputTokens);
    }
    if (filter.minSpeed !== undefined) {
      conditions.push("output_speed >= ?");
      params.push(filter.minSpeed);
    }
    if (filter.maxSpeed !== undefined) {
      conditions.push("output_speed <= ?");
      params.push(filter.maxSpeed);
    }
    if (filter.taskId !== undefined) {
      conditions.push("task_id = ?");
      params.push(filter.taskId);
    }

    return conditions.length > 0
      ? { sql: `WHERE ${conditions.join(" AND ")}`, params }
      : { sql: "", params: [] };
  }

  private rowToTask(row: Record<string, unknown>): TaskMetrics {
    return {
      taskId: row.task_id as number,
      rowId: row.rowid as number,
      slotId: row.slot_id as number | null,
      timestamp: row.timestamp as string | null,
      profile: row.profile as string | undefined,
      model: row.model as string | undefined,
      version: row.version as string | undefined,
      promptTokens: row.prompt_tokens as number | null,
      promptTimeMs: row.prompt_time_ms as number | null,
      promptSpeed: row.prompt_speed as number | null,
      outputTokens: row.output_tokens as number | null,
      evalTimeMs: row.eval_time_ms as number | null,
      outputSpeed: row.output_speed as number | null,
      totalTokens: row.total_tokens as number | null,
      totalTimeMs: row.total_time_ms as number | null,
      draftAccepted: row.draft_accepted as number | null,
      draftGenerated: row.draft_generated as number | null,
      draftAcceptance: row.draft_accepted !== null && row.draft_generated ? (row.draft_accepted as number) / (row.draft_generated as number) : null,
      contextSize: row.context_size as number | null,
      truncated: row.truncated === null ? null : row.truncated === 1,
      graphsReused: row.graphs_reused as number | null,
      runtime: row.runtime as "llama" | "strata", sourceSession: row.source_session as string,
      requestedInput: row.requested_input as number | null,
      processedInput: row.processed_input as number | null,
      cachedInput: row.cached_input as number | null,
      engineOutput: row.engine_output as number | null,
      wallTimeMs: row.wall_time_ms as number | null,
      finishReason: row.finish_reason as string | null,
    };
  }

  getTasksOverTime(bucket: TimeBucket, count: number): ChartDataPoint[] {
    if (!this.db || count <= 0) return [];
    const fmt = bucket === "hour" ? "strftime('%Y-%m-%d %H:00', timestamp)" : "strftime('%Y-%m-%d', timestamp)";
    const labels = this.generateTimeLabelsFromNow(bucket, count);
    const startDate = labels[0]!;
    const rows = this.db.prepare(`
      SELECT ${fmt} as bucket, COUNT(*) as cnt
      FROM tasks
      WHERE timestamp >= ?
      GROUP BY bucket
    `).all(startDate) as { bucket: string; cnt: number }[];
    const dataMap = new Map(rows.map(r => [r.bucket, r.cnt]));
    return labels.map(label => ({ label, value: dataMap.get(label) ?? 0 }));
  }

  getTokensOverTime(bucket: TimeBucket, count: number): TokensDataPoint[] {
    if (!this.db || count <= 0) return [];
    const fmt = bucket === "hour" ? "strftime('%Y-%m-%d %H:00', timestamp)" : "strftime('%Y-%m-%d', timestamp)";
    const labels = this.generateTimeLabelsFromNow(bucket, count);
    const startDate = labels[0]!;
    const rows = this.db.prepare(`
      SELECT ${fmt} as bucket,
        SUM(prompt_tokens) as pt,
        SUM(output_tokens) as ot
      FROM tasks
      WHERE timestamp >= ?
      GROUP BY bucket
    `).all(startDate) as { bucket: string; pt: number | null; ot: number | null }[];
    const dataMap = new Map(rows.map(r => [r.bucket, { promptTokens: r.pt, outputTokens: r.ot }]));
    return labels.map(label => ({
      label,
      promptTokens: dataMap.has(label) ? dataMap.get(label)!.promptTokens : 0,
      outputTokens: dataMap.has(label) ? dataMap.get(label)!.outputTokens : 0,
    }));
  }

  private generateTimeLabelsFromNow(bucket: TimeBucket, count: number): string[] {
    const labels: string[] = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now);
      if (bucket === "hour") {
        d.setUTCMinutes(0, 0, 0);
        d.setUTCHours(d.getUTCHours() - i);
      } else {
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
      }
      const label = bucket === "hour"
        ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:00`
        : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      labels.push(label);
    }
    return labels;
  }

  dispose() {
    if (this.stopTailer) this.stopTailer();
    logParser.stop();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.stmts = { insertTask: null, upsertStats: null, getCache: null };
  }
}

export const taskStore = new TaskStore();

logParser.on("task", (task: LlamaTask) => {
  taskStore.onTask(task);
});
