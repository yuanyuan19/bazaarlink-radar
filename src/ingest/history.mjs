import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPublicHistory } from "../core/public-data.mjs";
import { cachePath, printJson } from "../util.mjs";
import { migrateDb } from "../db/schema.mjs";
import { savePublicObservation } from "../db/repository.mjs";

export const BASE_INTERVAL_MS = 30 * 60_000;
export const MIN_INTERVAL_MS = 5 * 60_000;
export const MAX_INTERVAL_MS = 60 * 60_000;
const FETCH_LIMIT = 100;
const TARGET_OVERLAP_RATIO = 1 / 3;

export function dbPathOf(flags = {}) {
  return flags.db ? path.resolve(String(flags.db)) : cachePath("probe-history.sqlite");
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  migrateDb(db);
  return db;
}

// 轮询租约：只有一个进程能拿锁，按 next_poll_at 判断是否到期，
// 避免多个 ingest 实例同时打官方接口。
function acquirePollLease(db, owner, now = Date.now()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare("SELECT next_poll_at, lock_expires_at FROM ingest_state WHERE id = 1").get();
    const due = !state?.next_poll_at || Date.parse(state.next_poll_at) <= now;
    const locked = state?.lock_expires_at && Date.parse(state.lock_expires_at) > now;
    if (!due || locked) {
      db.exec("ROLLBACK");
      return { acquired: false, nextPollAt: state?.next_poll_at || null };
    }
    const expires = new Date(now + 10 * 60_000).toISOString();
    db.prepare("UPDATE ingest_state SET lock_owner = ?, lock_expires_at = ? WHERE id = 1").run(owner, expires);
    db.exec("COMMIT");
    return { acquired: true, nextPollAt: null };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function releasePollLease(db, owner) {
  db.prepare("UPDATE ingest_state SET lock_owner = NULL, lock_expires_at = NULL WHERE id = 1 AND lock_owner = ?").run(owner);
}

function setStateInterval(db, next, lastPollAt, windowIds) {
  db.prepare(
    "UPDATE ingest_state SET current_interval_ms = ?, next_poll_at = ?, last_poll_at = ?, last_success_at = ?, previous_window_ids = ?, last_error = NULL WHERE id = 1",
  ).run(next, new Date(Date.parse(lastPollAt) + next).toISOString(), lastPollAt, lastPollAt, JSON.stringify(windowIds));
}

export function planNextPoll({ currentIntervalMs, hadPriorWindow, previousWindowSize, windowSize, overlap, arrivals, elapsedMs }) {
  if (!hadPriorWindow || !previousWindowSize || !windowSize) return currentIntervalMs;
  if (arrivals <= 0) return MAX_INTERVAL_MS;
  if (overlap <= 0) return MIN_INTERVAL_MS;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return currentIntervalMs;
  const targetOverlap = windowSize * TARGET_OVERLAP_RATIO;
  const target = ((windowSize - targetOverlap) * elapsedMs) / arrivals;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, target));
}

function boundedInterval(value) {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Number(value)));
}

function validHistoryIds(history) {
  return [...new Set(history.filter((item) => item?.id).map((item) => String(item.id)))];
}

function readWindowIds(state) {
  if (!state?.previous_window_ids) return [];
  try {
    const ids = JSON.parse(state.previous_window_ids);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

export async function ingestOnce(flags = {}, dependencies = {}) {
  const fetchHistory = dependencies.getPublicHistory || getPublicHistory;
  const now = dependencies.now || (() => Date.now());
  const file = dbPathOf(flags);
  const db = openDb(file);
  const owner = crypto.randomUUID();
  if (flags.ifDue) {
    const lease = acquirePollLease(db, owner);
    if (!lease.acquired) {
      db.close();
      return { db: file, skipped: true, reason: "not_due_or_locked", nextPollAt: lease.nextPollAt };
    }
  }
  const state = db.prepare("SELECT current_interval_ms, last_success_at, previous_window_ids FROM ingest_state WHERE id = 1").get();
  const interval = Number(state.current_interval_ms);
  const previousWindowIds = readWindowIds(state);

  let data;
  try {
    data = await fetchHistory(flags, { limit: FETCH_LIMIT });
  } catch (error) {
    if (flags.ifDue) releasePollLease(db, owner);
    db.prepare("UPDATE ingest_state SET last_error = ? WHERE id = 1").run(error.message);
    db.close();
    throw error;
  }
  const history = data.history;
  const observedAt = now();
  const ingestedAt = new Date(observedAt).toISOString();
  const startedAt = ingestedAt;

  const windowIds = validHistoryIds(history);
  const previousSet = new Set(previousWindowIds);
  const overlap = windowIds.reduce((count, id) => count + (previousSet.has(id) ? 1 : 0), 0);
  const arrivals = windowIds.length - overlap;
  const hadPriorWindow = Boolean(state.last_success_at && state.previous_window_ids !== null);
  let inserted = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO ingest_runs(started_at, fetched, overlap, truncated) VALUES(?, ?, ?, ?)").run(startedAt, windowIds.length, overlap, data.truncated ? 1 : 0);
    const runId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
    for (const item of history) {
      if (!item || !item.id) continue;
      const exists = db.prepare("SELECT 1 FROM probe_runs WHERE id = ?").get(String(item.id));
      savePublicObservation(db, item, ingestedAt);
      if (!exists) inserted += 1;
    }
    const elapsedMs = state.last_success_at ? Date.parse(ingestedAt) - Date.parse(state.last_success_at) : null;
    const missed = hadPriorWindow && previousWindowIds.length > 0 && windowIds.length > 0 && overlap === 0;
    const next = flags.intervalMs ? boundedInterval(flags.intervalMs) : planNextPoll({
      currentIntervalMs: interval,
      hadPriorWindow,
      previousWindowSize: previousWindowIds.length,
      windowSize: windowIds.length,
      overlap,
      arrivals,
      elapsedMs,
    });
    setStateInterval(db, next, ingestedAt, windowIds);
    db.prepare(
      "UPDATE ingest_runs SET finished_at = ?, inserted = ?, missed = ?, error = NULL WHERE id = ?",
    ).run(ingestedAt, inserted, missed ? 1 : 0, runId);
    db.exec("COMMIT");

    const total = db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n;
    if (flags.ifDue) releasePollLease(db, owner);
    db.close();

    return {
      db: file,
      fetched: windowIds.length,
      inserted,
      total,
      truncated: Boolean(data.truncated),
      overlap,
      arrivals,
      missed,
      intervalMs: interval,
      nextIntervalMs: next,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    if (flags.ifDue) releasePollLease(db, owner);
    db.close();
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ingestWatch(flags = {}) {
  process.stderr.write(
    `history ingest watch  db=${dbPathOf(flags)}\n默认 ${BASE_INTERVAL_MS / 60000}min，目标重叠为窗口 1/3，范围 ${MIN_INTERVAL_MS / 60000}-${MAX_INTERVAL_MS / 60000}min\n`,
  );
  while (true) {
    const result = await ingestOnce(flags);
    process.stderr.write(
      `[ingest] +${result.inserted}/${result.fetched} overlap=${result.overlap} total=${result.total} next=${Math.round(result.nextIntervalMs / 60000)}min${result.missed ? " MISS" : ""}\n`,
    );
    printJson(result, flags.pretty);
    await sleep(result.nextIntervalMs);
  }
}
