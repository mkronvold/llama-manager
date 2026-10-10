import type Database from "better-sqlite3";
import fs from "fs-extra";

const COLUMNS = `
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER, slot_id INTEGER, timestamp TEXT, profile TEXT, model TEXT, version TEXT,
  prompt_tokens INTEGER, prompt_time_ms REAL, prompt_speed REAL,
  output_tokens INTEGER, eval_time_ms REAL, output_speed REAL,
  total_tokens INTEGER, total_time_ms REAL, draft_accepted INTEGER, draft_generated INTEGER,
  context_size INTEGER, truncated INTEGER, graphs_reused INTEGER,
  runtime TEXT NOT NULL DEFAULT 'llama', source_session TEXT NOT NULL DEFAULT 'legacy',
  requested_input INTEGER, processed_input INTEGER, cached_input INTEGER,
  engine_output INTEGER, wall_time_ms REAL, finish_reason TEXT,
  UNIQUE(runtime, source_session, task_id)
`;

export async function migrateTaskDatabase(db: Database.Database, dbPath: string): Promise<void> {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > 1) throw new Error(`Tasks database schema ${version} is newer than this manager supports`);
  if (version === 1) return;
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if (existing) {
    const backup = `${dbPath}.pre-session-${Date.now()}.bak`;
    await db.backup(backup);
    if (!(await fs.pathExists(backup))) throw new Error("Tasks migration backup was not created");
  }
  db.transaction(() => {
    if (existing) {
      db.exec(`ALTER TABLE tasks RENAME TO tasks_legacy; CREATE TABLE tasks (${COLUMNS});
        INSERT INTO tasks (rowid,task_id,slot_id,timestamp,profile,model,version,
          prompt_tokens,prompt_time_ms,prompt_speed,output_tokens,eval_time_ms,output_speed,
          total_tokens,total_time_ms,draft_accepted,draft_generated,context_size,truncated,graphs_reused,
          engine_output)
        SELECT rowid,task_id,slot_id,timestamp,profile,model,version,
          prompt_tokens,prompt_time_ms,prompt_speed,output_tokens,eval_time_ms,output_speed,
          total_tokens,total_time_ms,draft_accepted,draft_generated,context_size,truncated,graphs_reused,
          output_tokens FROM tasks_legacy;
        DROP TABLE tasks_legacy;`);
    } else {
      db.exec(`CREATE TABLE tasks (${COLUMNS})`);
    }
    db.exec(`
      CREATE INDEX idx_tasks_timestamp ON tasks(timestamp);
      CREATE INDEX idx_tasks_slot_id ON tasks(slot_id);
      CREATE INDEX idx_tasks_model ON tasks(model);
      CREATE TABLE IF NOT EXISTS stats_cache (key TEXT PRIMARY KEY, value REAL);
      CREATE TABLE task_sources (
        runtime TEXT NOT NULL, session_id TEXT NOT NULL, watermark INTEGER NOT NULL,
        PRIMARY KEY(runtime, session_id)
      );
      CREATE TABLE task_log_sources (
        session_id TEXT PRIMARY KEY, log_path TEXT NOT NULL, log_start INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL, profile TEXT, model TEXT, version TEXT
      );
      CREATE INDEX idx_task_log_sources_path ON task_log_sources(log_path, log_start);
      CREATE TABLE task_history_gaps (
        session_id TEXT NOT NULL, first_ordinal INTEGER NOT NULL, last_ordinal INTEGER NOT NULL,
        PRIMARY KEY(session_id, first_ordinal)
      );
      PRAGMA user_version = 1;
    `);
  })();
}
