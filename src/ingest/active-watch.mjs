import { getJson } from "../api/client.mjs";
import { ingestOnce } from "./history.mjs";

export const ACTIVE_IDLE_MS = 10_000;
export const ACTIVE_BUSY_MS = 5_000;

// 与官方页面同一套节奏：盯 /api/probe/active，有任务时 5s、空闲 10s。
// 某个 runId 从 active 里消失 = 它刚完成，此刻拉一次 history 必然抓到它。
export function planActivePoll(prevIds, nextIds) {
  const next = new Set(nextIds);
  const finished = [...prevIds].filter((id) => !next.has(id));
  return {
    finished,
    shouldIngest: finished.length > 0,
    delayMs: next.size > 0 ? ACTIVE_BUSY_MS : ACTIVE_IDLE_MS,
  };
}

export function startActiveWatch(flags, dependencies = {}) {
  const fetchActive = dependencies.getActive || ((f) => getJson(f, "/api/probe/active"));
  const ingest = dependencies.ingestOnce || ingestOnce;
  const log = dependencies.log || ((line) => process.stderr.write(`[mirror] ${line}\n`));
  let known = new Set();
  let primed = false;
  let timer = null;
  let stopped = false;
  let ingesting = false;

  async function runIngest(reason) {
    if (ingesting) return;
    ingesting = true;
    try {
      const result = await ingest(flags);
      log(`ingest(${reason}) +${result.inserted}/${result.fetched} total=${result.total}`);
    } catch (error) {
      log(`ingest(${reason}) failed: ${error.message}`);
    } finally {
      ingesting = false;
    }
  }

  async function tick() {
    if (stopped) return;
    let delayMs = ACTIVE_IDLE_MS;
    try {
      const data = await fetchActive(flags);
      const ids = (data?.active || []).map((item) => String(item.runId || item.id || "")).filter(Boolean);
      const plan = planActivePoll(known, ids);
      known = new Set(ids);
      delayMs = plan.delayMs;
      if (!primed) {
        primed = true;
        await runIngest("startup");
      } else if (plan.shouldIngest) {
        await runIngest(`${plan.finished.length} finished`);
      }
    } catch (error) {
      log(`active poll failed: ${error.message}`);
    }
    if (!stopped) timer = setTimeout(tick, delayMs);
  }

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
