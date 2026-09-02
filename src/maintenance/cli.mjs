import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPathOf } from "../ingest/history.mjs";
import { migrateDb } from "../db/schema.mjs";

function dbFrom(flags) {
  const db = new DatabaseSync(dbPathOf(flags));
  migrateDb(db);
  return db;
}

export function runMaintenance(command, flags = {}) {
  if (!command) throw new Error("maintenance 需要 migrate、cleanup 或 backup");
  const db = dbFrom(flags);
  try {
    if (command === "migrate") return { command, version: migrateDb(db) };
    if (command === "cleanup") {
      const cutoff = new Date(Date.now() - Number(flags.rawDays || 90) * 86400_000).toISOString();
      const logs = db.prepare("DELETE FROM ingest_runs WHERE started_at < ?").run(cutoff).changes;
      const removedState =
        db.prepare("UPDATE ingest_state SET last_error = NULL WHERE id = 1 AND last_error IS NOT NULL").changes;
      const rawDir = path.resolve(String(flags.rawDir || process.env.RAW_DIR || path.join(path.dirname(dbPathOf(flags)), "raw")));
      let deletedRaw = 0;
      if (fs.existsSync(rawDir)) {
        for (const name of fs.readdirSync(rawDir)) {
          const file = path.join(rawDir, name);
          const stat = fs.statSync(file);
          if (stat.isFile() && stat.mtimeMs < Date.parse(cutoff)) {
            fs.unlinkSync(file);
            deletedRaw += 1;
          }
        }
      }
      return { command, cutoff, deletedLogs: logs, clearedErrors: removedState, deletedRaw };
    }
    if (command === "backup") {
      const targetDir = path.resolve(String(flags.backupDir || process.env.BACKUP_DIR || path.join(path.dirname(dbPathOf(flags)), "..", "backups")));
      fs.mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, `probe-history-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      const check = new DatabaseSync(target);
      const integrity = check.prepare("PRAGMA integrity_check").get().integrity_check;
      check.close();
      if (integrity !== "ok") throw new Error(`backup integrity check failed: ${integrity}`);
      return { command, target, integrity };
    }
    throw new Error(`未知 maintenance 命令: ${command}`);
  } finally {
    db.close();
  }
}
