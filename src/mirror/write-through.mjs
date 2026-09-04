import { saveRunDetails } from "../db/repository.mjs";

const DETAIL_TIMEOUT_MS = 2000;

export function hasRun(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM probe_runs WHERE (id = ? OR run_uuid = ?) AND is_public = 1").get(id, id));
}

// 代理看到 run/{id} 返回 completed 时，在把响应交给浏览器之前，把这一条写进库。
// 官方前端拿到 completed 后会立刻重拉列表；写穿保证那次列表请求查库时记录已在。
// 详情拉不到就放行：几秒后 active 差分会拉列表捞回，走现有路径，不重试。
export async function writeThroughCompleted(db, origin, runId, dependencies = {}) {
  const id = String(runId || "");
  if (!id || hasRun(db, id)) return { written: false, reason: "known" };
  const fetchImpl = dependencies.fetch || fetch;
  const log = dependencies.log || ((line) => process.stderr.write(`[mirror] ${line}\n`));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), dependencies.timeoutMs || DETAIL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin}/api/probe/history/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) {
      log(`write-through ${id}: HTTP ${res.status}`);
      return { written: false, reason: `http ${res.status}` };
    }
    const details = await res.json();
    if (!details?.id && !details?.runId) return { written: false, reason: "empty" };
    saveRunDetails(db, { ...details, id: details.id || details.runId, runId: details.runId || id }, new Date().toISOString(), { sourceType: "public_history" });
    return { written: true, id: String(details.id || details.runId) };
  } catch (error) {
    log(`write-through ${id}: ${error.name === "AbortError" ? "timeout" : error.message}`);
    return { written: false, reason: error.message };
  } finally {
    clearTimeout(timer);
  }
}
