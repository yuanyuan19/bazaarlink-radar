import { getJson } from "../api/client.mjs";
import { ingestOnce } from "./history.mjs";

export const ACTIVE_IDLE_MS = 10_000;
export const ACTIVE_BUSY_MS = 5_000;
// 官方窗口 100 条，高峰约每小时 40–60 条：任意 10 分钟内拉过一次就不可能漏。
export const WATCHDOG_STALE_MS = 10 * 60_000;
export const WATCHDOG_TICK_MS = 60_000;

// 与官方页面同一节奏：有任务 5s、空闲 10s；某个 runId 从 active 消失 = 刚完成。
export function planActivePoll(prevIds, nextIds) {
  const next = new Set(nextIds);
  const finished = [...prevIds].filter((id) => !next.has(id));
  return { finished, shouldIngest: finished.length > 0, delayMs: next.size > 0 ? ACTIVE_BUSY_MS : ACTIVE_IDLE_MS };
}

// 采集调度器。两种触发（active 差分 / 定时看门狗）都汇到 ingestNow，
// 同一时刻只有一次入库在飞，撞车的调用共用同一个 promise。
// 自己刚跑完的那条不走这里：由代理在 completed 响应返回前写穿单条（mirror/write-through.mjs）。
export function createCollector(flags = {}, dependencies = {}) {
  const ingest = dependencies.ingestOnce || ingestOnce;
  const fetchActive = dependencies.getActive || ((f) => getJson(f, "/api/probe/active"));
  const now = dependencies.now || (() => Date.now());
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const log = dependencies.log || ((line) => process.stderr.write(`[mirror] ${line}\n`));

  let inflight = null;
  let lastSuccessAt = 0;
  let lastReason = null;
  let lastError = null;
  let activeOk = null;
  let known = new Set();
  let stopped = false;
  const timers = new Set();

  function ingestNow(reason) {
    if (inflight) return inflight;
    inflight = ingest({ ...flags, reason })
      .then((result) => {
        lastSuccessAt = now();
        lastReason = reason;
        lastError = null;
        log(`ingest(${reason}) +${result.inserted}/${result.fetched} total=${result.total}`);
        return result;
      })
      .catch((error) => {
        lastError = error.message;
        log(`ingest(${reason}) failed: ${error.message}`);
        return null;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function schedule(fn, ms) {
    if (stopped) return;
    const t = setTimer(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  }

  async function activeTick() {
    if (stopped) return;
    let delayMs = ACTIVE_IDLE_MS;
    try {
      const data = await fetchActive(flags);
      const ids = (data?.active || []).map((item) => String(item.runId || item.id || "")).filter(Boolean);
      const plan = planActivePoll(known, ids);
      known = new Set(ids);
      activeOk = true;
      delayMs = plan.delayMs;
      if (plan.shouldIngest) await ingestNow(`${plan.finished.length} finished`);
    } catch (error) {
      activeOk = false;
      log(`active poll failed: ${error.message}`);
    }
    schedule(activeTick, delayMs);
  }

  async function watchdogTick() {
    if (stopped) return;
    if (now() - lastSuccessAt >= WATCHDOG_STALE_MS) await ingestNow("watchdog");
    schedule(watchdogTick, WATCHDOG_TICK_MS);
  }

  function start() {
    ingestNow("startup").then(() => {
      activeTick();
      schedule(watchdogTick, WATCHDOG_TICK_MS);
    });
  }

  function stop() {
    stopped = true;
    for (const t of timers) clearTimer(t);
    timers.clear();
  }

  function status() {
    return {
      lastIngestAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
      lastIngestReason: lastReason,
      lastError,
      activePollOk: activeOk,
      ingesting: Boolean(inflight),
    };
  }

  return { start, stop, ingestNow, status, activeTick, watchdogTick };
}
