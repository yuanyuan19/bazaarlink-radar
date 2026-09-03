import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { BASE_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS, planNextPoll } from "../src/ingest/history.mjs";
import { ingestOnce } from "../src/ingest/history.mjs";

const minute = 60_000;

test("uses the base interval before the first successful window", () => {
  assert.equal(planNextPoll({ currentIntervalMs: BASE_INTERVAL_MS, hadPriorWindow: false, previousWindowSize: 0, windowSize: 100, overlap: 0, arrivals: 100, elapsedMs: 30 * minute }), BASE_INTERVAL_MS);
});

test("targets one third overlap from the observed arrival rate", () => {
  assert.equal(planNextPoll({ currentIntervalMs: BASE_INTERVAL_MS, hadPriorWindow: true, previousWindowSize: 100, windowSize: 100, overlap: 70, arrivals: 30, elapsedMs: 30 * minute }), MAX_INTERVAL_MS);
});

test("clamps slow and fast rates to the configured bounds", () => {
  assert.equal(planNextPoll({ currentIntervalMs: BASE_INTERVAL_MS, hadPriorWindow: true, previousWindowSize: 100, windowSize: 100, overlap: 90, arrivals: 10, elapsedMs: 30 * minute }), MAX_INTERVAL_MS);
  assert.equal(planNextPoll({ currentIntervalMs: BASE_INTERVAL_MS, hadPriorWindow: true, previousWindowSize: 100, windowSize: 100, overlap: 1, arrivals: 99, elapsedMs: 5 * minute }), MIN_INTERVAL_MS);
});

test("uses the maximum interval when the window is unchanged", () => {
  assert.equal(planNextPoll({ currentIntervalMs: BASE_INTERVAL_MS, hadPriorWindow: true, previousWindowSize: 100, windowSize: 100, overlap: 100, arrivals: 0, elapsedMs: 30 * minute }), MAX_INTERVAL_MS);
});

test("uses the minimum interval when consecutive windows have no overlap", () => {
  assert.equal(planNextPoll({ currentIntervalMs: BASE_INTERVAL_MS, hadPriorWindow: true, previousWindowSize: 100, windowSize: 100, overlap: 0, arrivals: 100, elapsedMs: 30 * minute }), MIN_INTERVAL_MS);
});

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-ingest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "history.sqlite");
}

function item(id) {
  return { id, baseUrl: `https://${id}.example/v1`, modelId: "test-model", createdAt: "2026-09-03T00:00:00Z" };
}

test("migrates a v2 database without inventing a previous window", (t) => {
  const dbFile = tempDb(t);
  const db = new DatabaseSync(dbFile);
  migrateDb(db);
  db.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
  db.exec("ALTER TABLE ingest_runs DROP COLUMN overlap; ALTER TABLE ingest_state DROP COLUMN previous_window_ids");
  migrateDb(db);
  assert.ok(db.prepare("PRAGMA table_info(ingest_runs)").all().some((column) => column.name === "overlap"));
  const state = db.prepare("SELECT previous_window_ids FROM ingest_state WHERE id = 1").get();
  assert.equal(state.previous_window_ids, null);
  db.close();
});

test("compares consecutive windows and records real inserts", async (t) => {
  const dbFile = tempDb(t);
  const windows = [["a", "b", "c"], ["b", "c", "d"]];
  const times = [Date.parse("2026-09-03T00:00:00Z"), Date.parse("2026-09-03T00:30:00Z")];
  const fetchHistory = async () => ({ history: windows.shift().map(item), truncated: false });

  const first = await ingestOnce({ db: dbFile }, { getPublicHistory: fetchHistory, now: () => times.shift() });
  const second = await ingestOnce({ db: dbFile }, { getPublicHistory: fetchHistory, now: () => times.shift() });

  assert.deepEqual({ inserted: first.inserted, overlap: first.overlap, missed: first.missed }, { inserted: 3, overlap: 0, missed: false });
  assert.deepEqual({ inserted: second.inserted, overlap: second.overlap, arrivals: second.arrivals, missed: second.missed }, { inserted: 1, overlap: 2, arrivals: 1, missed: false });
  assert.equal(second.nextIntervalMs, MAX_INTERVAL_MS);

  const db = new DatabaseSync(dbFile);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 4);
  assert.deepEqual(JSON.parse(db.prepare("SELECT previous_window_ids FROM ingest_state WHERE id = 1").get().previous_window_ids), ["b", "c", "d"]);
  db.close();
});

test("an empty successful window preserves the interval and is not a miss", async (t) => {
  const dbFile = tempDb(t);
  const db = new DatabaseSync(dbFile);
  migrateDb(db);
  db.prepare("UPDATE ingest_state SET current_interval_ms = ?, last_success_at = ?, previous_window_ids = ? WHERE id = 1")
    .run(30 * minute, "2026-09-03T00:00:00Z", JSON.stringify(["a", "b"]));
  db.close();

  const result = await ingestOnce({ db: dbFile }, {
    getPublicHistory: async () => ({ history: [], truncated: false }),
    now: () => Date.parse("2026-09-03T00:30:00Z"),
  });
  assert.equal(result.nextIntervalMs, 30 * minute);
  assert.equal(result.missed, false);
});

test("a failed fetch leaves the previous window and interval unchanged", async (t) => {
  const dbFile = tempDb(t);
  const db = new DatabaseSync(dbFile);
  migrateDb(db);
  db.prepare("UPDATE ingest_state SET current_interval_ms = ?, last_success_at = ?, previous_window_ids = ? WHERE id = 1")
    .run(45 * minute, "2026-09-03T00:00:00Z", JSON.stringify(["a", "b"]));
  db.close();

  await assert.rejects(() => ingestOnce({ db: dbFile }, { getPublicHistory: async () => { throw new Error("upstream unavailable"); } }), /upstream unavailable/);
  const afterDb = new DatabaseSync(dbFile);
  const after = afterDb.prepare("SELECT current_interval_ms, last_success_at, previous_window_ids, last_error FROM ingest_state WHERE id = 1").get();
  assert.equal(after.current_interval_ms, 45 * minute);
  assert.equal(after.last_success_at, "2026-09-03T00:00:00Z");
  assert.equal(after.previous_window_ids, JSON.stringify(["a", "b"]));
  assert.equal(after.last_error, "upstream unavailable");
  afterDb.close();
});
