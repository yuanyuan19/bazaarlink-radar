import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { ingestOnce } from "../src/ingest/history.mjs";
import { ACTIVE_BUSY_MS, ACTIVE_IDLE_MS, WATCHDOG_STALE_MS, createCollector, planActivePoll } from "../src/ingest/collector.mjs";

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-ingest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "history.sqlite");
}

function item(id) {
  return { id, baseUrl: `https://${id}.example/v1`, modelId: "test-model", createdAt: "2026-09-03T00:00:00Z" };
}

test("ingestOnce upserts by id and records the trigger reason", async (t) => {
  const dbFile = tempDb(t);
  const windows = [["a", "b", "c"], ["b", "c", "d"]];
  const fetchHistory = async () => ({ history: windows.shift().map(item), truncated: true });
  const first = await ingestOnce({ db: dbFile, reason: "startup" }, { getPublicHistory: fetchHistory });
  const second = await ingestOnce({ db: dbFile, reason: "watchdog" }, { getPublicHistory: fetchHistory });
  assert.equal(first.inserted, 3);
  assert.equal(second.inserted, 1);
  assert.equal(second.total, 4);
  const db = new DatabaseSync(dbFile);
  assert.deepEqual(db.prepare("SELECT reason, inserted FROM ingest_runs ORDER BY id").all().map((r) => [r.reason, r.inserted]), [["startup", 3], ["watchdog", 1]]);
  assert.ok(db.prepare("SELECT last_success_at FROM ingest_state WHERE id = 1").get().last_success_at);
  db.close();
});

test("a failed fetch records the error and keeps the last success", async (t) => {
  const dbFile = tempDb(t);
  await ingestOnce({ db: dbFile }, { getPublicHistory: async () => ({ history: [item("a")] }) });
  await assert.rejects(() => ingestOnce({ db: dbFile }, { getPublicHistory: async () => { throw new Error("upstream unavailable"); } }), /upstream unavailable/);
  const db = new DatabaseSync(dbFile);
  const state = db.prepare("SELECT last_success_at, last_error FROM ingest_state WHERE id = 1").get();
  assert.ok(state.last_success_at);
  assert.equal(state.last_error, "upstream unavailable");
  assert.equal(db.prepare("SELECT error FROM ingest_runs ORDER BY id DESC LIMIT 1").get().error, "upstream unavailable");
  db.close();
});

test("migrating an old database drops the scheduler columns", (t) => {
  const dbFile = tempDb(t);
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE ingest_state (id INTEGER PRIMARY KEY, next_poll_at TEXT, lock_owner TEXT, current_interval_ms INTEGER NOT NULL DEFAULT 1, last_success_at TEXT, previous_window_ids TEXT, last_error TEXT);
    INSERT INTO ingest_state(id) VALUES (1);
    CREATE TABLE ingest_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, fetched INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, overlap INTEGER NOT NULL DEFAULT 0, missed INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, error TEXT);
  `);
  migrateDb(db);
  const stateCols = db.prepare("PRAGMA table_info(ingest_state)").all().map((c) => c.name);
  const runCols = db.prepare("PRAGMA table_info(ingest_runs)").all().map((c) => c.name);
  assert.deepEqual(stateCols.sort(), ["id", "last_error", "last_poll_at", "last_success_at"]);
  assert.ok(runCols.includes("reason") && !runCols.includes("overlap") && !runCols.includes("missed"));
  db.close();
});

test("planActivePoll flags finished runs and picks the official cadence", () => {
  assert.deepEqual(planActivePoll(["a", "b"], ["b"]), { finished: ["a"], shouldIngest: true, delayMs: ACTIVE_BUSY_MS });
  assert.deepEqual(planActivePoll(["a"], []), { finished: ["a"], shouldIngest: true, delayMs: ACTIVE_IDLE_MS });
  assert.equal(planActivePoll([], ["a"]).shouldIngest, false);
});

function fakeCollector(overrides = {}) {
  const calls = [];
  let clock = 0;
  let resolveIngest = null;
  const timers = [];
  const collector = createCollector({}, {
    now: () => clock,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    log: () => {},
    ingestOnce: (flags) => {
      calls.push(flags.reason);
      return new Promise((resolve) => {
        resolveIngest = () => resolve({ inserted: 1, fetched: 1, total: 1 });
      });
    },
    hasRun: overrides.hasRun || (() => false),
    getActive: overrides.getActive || (async () => ({ active: [] })),
  });
  return { collector, calls, timers, tick: (ms) => { clock += ms; }, finish: () => resolveIngest && resolveIngest() };
}

test("concurrent triggers share one in-flight ingest", async () => {
  const { collector, calls, finish } = fakeCollector();
  const a = collector.ingestNow("1 finished");
  const b = collector.ingestNow("watchdog");
  const c = collector.notifyCompleted("run-1");
  assert.equal(a, b);
  assert.equal(a, c);
  const waiting = collector.waitForPending(1000);
  finish();
  assert.equal(await waiting, true);
  await a;
  assert.deepEqual(calls, ["1 finished"]);
  assert.equal(await collector.waitForPending(1000), false);
});

test("notifyCompleted skips runs already in the database", async () => {
  const { collector, calls } = fakeCollector({ hasRun: (id) => id === "known" });
  assert.equal(await collector.notifyCompleted("known"), null);
  collector.notifyCompleted("fresh");
  assert.deepEqual(calls, ["completed:fresh"]);
});

test("watchdog only fires once the last success is stale", async () => {
  const { collector, calls, tick, finish } = fakeCollector();
  const p = collector.ingestNow("startup");
  finish();
  await p;
  tick(WATCHDOG_STALE_MS - 1);
  await collector.watchdogTick();
  assert.deepEqual(calls, ["startup"]);
  tick(2);
  const w = collector.watchdogTick();
  finish();
  await w;
  assert.deepEqual(calls, ["startup", "watchdog"]);
});

test("active tick ingests when a run disappears", async () => {
  const responses = [{ active: [{ runId: "a" }] }, { active: [] }];
  const { collector, calls, finish } = fakeCollector({ getActive: async () => responses.shift() });
  await collector.activeTick();
  assert.deepEqual(calls, []);
  const second = collector.activeTick();
  await new Promise((r) => setImmediate(r));
  finish();
  await second;
  assert.deepEqual(calls, ["1 finished"]);
});
