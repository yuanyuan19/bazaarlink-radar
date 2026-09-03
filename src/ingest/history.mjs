import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPublicHistory } from "../core/public-data.mjs";
import { cachePath } from "../util.mjs";
import { migrateDb } from "../db/schema.mjs";
import { savePublicObservation } from "../db/repository.mjs";

const FETCH_LIMIT = 100;

export function dbPathOf(flags = {}) {
  return flags.db ? path.resolve(String(flags.db)) : cachePath("probe-history.sqlite");
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  migrateDb(db);
  return db;
}

// 拉一次官方 history 窗口并按 id 幂等入库。没有调度逻辑：什么时候拉由 collector 决定。
export async function ingestOnce(flags = {}, dependencies = {}) {
  const fetchHistory = dependencies.getPublicHistory || getPublicHistory;
  const now = dependencies.now || (() => Date.now());
  const reason = String(flags.reason || dependencies.reason || "manual");
  const file = dbPathOf(flags);
  const db = openDb(file);
  const startedAt = new Date(now()).toISOString();
  const runRow = db.prepare("INSERT INTO ingest_runs(started_at, reason) VALUES(?, ?)").run(startedAt, reason);
  const ingestRunId = Number(runRow.lastInsertRowid);

  let data;
  try {
    data = await fetchHistory(flags, { limit: FETCH_LIMIT });
  } catch (error) {
    const failedAt = new Date(now()).toISOString();
    db.prepare("UPDATE ingest_runs SET finished_at = ?, error = ? WHERE id = ?").run(failedAt, error.message, ingestRunId);
    db.prepare("UPDATE ingest_state SET last_error = ? WHERE id = 1").run(error.message);
    db.close();
    throw error;
  }

  const history = Array.isArray(data?.history) ? data.history : [];
  const ingestedAt = new Date(now()).toISOString();
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const exists = db.prepare("SELECT 1 FROM probe_runs WHERE id = ?");
    for (const item of history) {
      if (!item || !item.id) continue;
      const had = exists.get(String(item.id));
      savePublicObservation(db, item, ingestedAt);
      if (!had) inserted += 1;
    }
    db.prepare("UPDATE ingest_runs SET finished_at = ?, fetched = ?, inserted = ?, truncated = ?, error = NULL WHERE id = ?")
      .run(ingestedAt, history.length, inserted, data?.truncated ? 1 : 0, ingestRunId);
    db.prepare("UPDATE ingest_state SET last_poll_at = ?, last_success_at = ?, last_error = NULL WHERE id = 1").run(ingestedAt, ingestedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const total = db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n;
  db.close();
  return { db: file, reason, fetched: history.length, inserted, total, truncated: Boolean(data?.truncated), ingestedAt };
}
