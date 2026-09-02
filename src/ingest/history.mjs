import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPublicHistory } from "../core/public-data.mjs";
import { cachePath, printJson } from "../util.mjs";
import { migrateDb } from "../db/schema.mjs";
import { savePublicObservation } from "../db/repository.mjs";

export const BASE_INTERVAL_MS = 30 * 60_000;
export const MIN_INTERVAL_MS = 5 * 60_000;
export const MAX_INTERVAL_MS = 30 * 60_000;
const FETCH_LIMIT = 100;

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

function setStateInterval(db, next, lastPollAt) {
  db.prepare(
    "UPDATE ingest_state SET current_interval_ms = ?, next_poll_at = ?, last_poll_at = ?, last_success_at = ? WHERE id = 1",
  ).run(next, new Date(Date.now() + next).toISOString(), lastPollAt, lastPollAt);
}

// 根据本窗口抓到的数据量推算下一次轮询间隔。
// 漏窗口（几乎全是新的或有缺口）→ 减到最小；数据稀少 → 放宽；否则维持。
function nextInterval(current, { fetched, inserted, spanMs, missed, hadPrior }) {
  let next = current;
  const overflow = hadPrior && inserted >= Math.max(90, fetched - 5);
  if (missed || overflow || (spanMs && spanMs < current * 0.8)) {
    next = Math.max(MIN_INTERVAL_MS, Math.floor(current / 2));
    if (missed || overflow) next = MIN_INTERVAL_MS;
  } else if (inserted <= 15 && spanMs && spanMs > current * 2.5) {
    next = Math.min(MAX_INTERVAL_MS, Math.floor(current * 1.25));
  } else if (inserted < 40) {
    next = Math.min(MAX_INTERVAL_MS, current + 60_000);
  }
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, next));
}

export async function ingestOnce(flags = {}) {
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
  const interval = Number(db.prepare("SELECT current_interval_ms FROM ingest_state WHERE id = 1").get().current_interval_ms);
  const prevMax = db.prepare("SELECT MAX(created_at) AS t FROM probe_runs").get()?.t || null;

  let data;
  try {
    data = await getPublicHistory(flags, { limit: FETCH_LIMIT });
  } catch (error) {
    if (flags.ifDue) releasePollLease(db, owner);
    db.prepare("UPDATE ingest_state SET last_error = ? WHERE id = 1").run(error.message);
    db.close();
    throw error;
  }
  const history = data.history;
  const ingestedAt = new Date().toISOString();
  const startedAt = ingestedAt;

  let inserted = 0;
  db.prepare("INSERT INTO ingest_runs(started_at, fetched, truncated) VALUES(?, ?, ?)").run(startedAt, history.length, data.truncated ? 1 : 0);
  const runId = db.prepare("SELECT last_insert_rowid() AS id").get().id;

  db.exec("BEGIN");
  try {
    for (const item of history) {
      if (!item || !item.id) continue;
      const saved = savePublicObservation(db, item, ingestedAt);
      if (saved) inserted += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    throw err;
  }

  const times = history.filter((r) => Number.isFinite(Date.parse(r.createdAt))).map((r) => Date.parse(r.createdAt));
  const newest = times.length ? Math.max(...times) : null;
  const oldest = times.length ? Math.min(...times) : null;
  const spanMs = newest != null && oldest != null ? newest - oldest : null;

  const hadPrior = Boolean(prevMax);
  let missed = false;
  if (hadPrior && oldest != null) {
    const prev = Date.parse(prevMax);
    if (Number.isFinite(prev) && oldest > prev + 5_000 && inserted === history.length && history.length >= 90) {
      missed = true;
    }
  }
  if (hadPrior && history.length >= FETCH_LIMIT && inserted >= FETCH_LIMIT) missed = true;

  const next = flags.intervalMs ? Number(flags.intervalMs) : nextInterval(interval, { fetched: history.length, inserted, spanMs, missed, hadPrior });
  setStateInterval(db, next, ingestedAt);

  db.prepare(
    "UPDATE ingest_runs SET finished_at = ?, inserted = ?, detail_pending = 0, missed = ?, error = NULL WHERE id = ?",
  ).run(new Date().toISOString(), inserted, missed ? 1 : 0, runId);

  const total = db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n;
  if (flags.ifDue) releasePollLease(db, owner);
  db.close();

  return {
    db: file,
    fetched: history.length,
    inserted,
    total,
    truncated: Boolean(data.truncated),
    window: {
      newest: newest ? new Date(newest).toISOString() : null,
      oldest: oldest ? new Date(oldest).toISOString() : null,
      spanMinutes: spanMs != null ? Math.round(spanMs / 60000) : null,
    },
    missed,
    intervalMs: interval,
    nextIntervalMs: next,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ingestWatch(flags = {}) {
  process.stderr.write(
    `history ingest watch  db=${dbPathOf(flags)}\n默认 ${BASE_INTERVAL_MS / 60000}min，漏窗口则加快到 ${MIN_INTERVAL_MS / 60000}min\n`,
  );
  while (true) {
    const result = await ingestOnce(flags);
    process.stderr.write(
      `[ingest] +${result.inserted}/${result.fetched} total=${result.total} span=${result.window.spanMinutes}min next=${Math.round(result.nextIntervalMs / 60000)}min${result.missed ? " MISS" : ""}\n`,
    );
    printJson(result, flags.pretty);
    await sleep(result.nextIntervalMs);
  }
}
