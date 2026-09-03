import { displayScore } from "../core/probe-run.mjs";

export function numberParam(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function like(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&")}%`;
}

export function scoreExpr() {
  return "CASE WHEN rr.score IS NULL THEN NULL WHEN rr.score <= 1 THEN rr.score * 100 ELSE rr.score END";
}

function normalizeApiScore(score) {
  if (score == null || score === "") return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n : n / 100;
}

// 输出与官方 /api/probe/history 每一项同形，官方 React 组件直接渲染。
export function toHistoryApiRow(row) {
  return {
    id: row.id,
    runId: row.run_uuid || undefined,
    baseUrl: row.base_url,
    modelId: row.claimed_model_id || row.request_model || row.model_id || null,
    score: normalizeApiScore(row.score),
    createdAt: row.created_at,
    identityConfirmed: row.identity_confirmed === 1,
    confirmedMismatch: row.confirmed_mismatch === 1,
    mostSimilarDisplayName: row.actual_model || null,
    errorCount: row.error_count ?? 0,
  };
}

export function displayScoreOf(item) {
  return displayScore(item?.score);
}

export function isRunningItem(item) {
  return item?.score === null && Number(item?.totalProbes) > 0;
}

export function matchesQuery(item, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  return `${item.baseUrl || ""} ${item.modelId || ""}`.toLowerCase().includes(needle);
}

export function matchesBand(item, band) {
  const b = String(band || "all");
  if (b === "all") return true;
  const running = isRunningItem(item);
  if (b === "running") return running;
  if (running) return false;
  const ds = displayScoreOf(item);
  if (ds == null) return false;
  if (b === "80") return ds >= 80;
  if (b === "50") return ds >= 50;
  if (b === "low") return ds < 50;
  return true;
}

function bandClause(band) {
  const score = scoreExpr();
  switch (String(band || "all")) {
    case "80":
      return `${score} >= 80`;
    case "50":
      return `${score} >= 50`;
    case "low":
      return `${score} IS NOT NULL AND ${score} < 50`;
    case "running":
      return "0";
    default:
      return null;
  }
}

function buildWhere({ q, band, excludeIds }) {
  const conditions = [
    "EXISTS (SELECT 1 FROM run_sources src WHERE src.run_id = pr.id AND src.source_type = 'public_history')",
  ];
  const params = [];
  if (q) {
    conditions.push("(pr.base_url LIKE ? ESCAPE '\\' OR pr.claimed_model_id LIKE ? ESCAPE '\\' OR s.host LIKE ? ESCAPE '\\')");
    params.push(like(q), like(q), like(q));
  }
  const bandSql = bandClause(band);
  if (bandSql) conditions.push(bandSql);
  const ids = [...new Set((excludeIds || []).map(String).filter(Boolean))].slice(0, 400);
  if (ids.length) {
    conditions.push(`pr.id NOT IN (${ids.map(() => "?").join(",")}) AND (pr.run_uuid IS NULL OR pr.run_uuid NOT IN (${ids.map(() => "?").join(",")}))`);
    params.push(...ids, ...ids);
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

const JOINS = `
  FROM probe_runs pr
  LEFT JOIN sites s ON s.id = pr.site_id
  LEFT JOIN probe_results rr ON rr.run_id = pr.id
  LEFT JOIN my_submissions ms ON ms.run_id = pr.id
`;

export function countPublicHistory(db, options = {}) {
  const { where, params } = buildWhere(options);
  return db.prepare(`SELECT COUNT(*) AS n ${JOINS} ${where}`).get(...params).n;
}

export function queryPublicHistory(db, options = {}) {
  const limit = numberParam(options.limit, 50, 1, 200);
  const offset = numberParam(options.offset, 0, 0, 10_000_000);
  const { where, params } = buildWhere(options);
  const rows = db.prepare(`
    SELECT pr.id, pr.run_uuid, pr.base_url, pr.claimed_model_id, pr.created_at,
           rr.model_id, rr.actual_model, rr.score, rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
           ms.request_model
    ${JOINS}
    ${where}
    ORDER BY COALESCE(pr.created_at, '') DESC, pr.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return rows.map(toHistoryApiRow);
}

// 合并页：官方当前窗口（按 q/band 过滤）排前面，本地库里不在官方集合内的记录接在后面。
export function mergedHistoryPage(db, officialRows, options = {}) {
  const limit = numberParam(options.limit, 50, 1, 200);
  const page = numberParam(options.page, 1, 1, 100_000);
  const q = String(options.q || "").trim();
  const band = String(options.band || "all");
  const official = (officialRows || []).filter((item) => item?.id && matchesQuery(item, q) && matchesBand(item, band));
  const excludeIds = [];
  for (const item of officialRows || []) {
    if (item?.id) excludeIds.push(String(item.id));
    if (item?.runId) excludeIds.push(String(item.runId));
  }
  const localTotal = band === "running" ? 0 : countPublicHistory(db, { q, band, excludeIds });
  const total = official.length + localTotal;
  const pages = Math.max(1, Math.ceil(total / limit));
  const offset = (Math.min(page, pages) - 1) * limit;

  let history = official.slice(offset, offset + limit);
  const need = limit - history.length;
  if (need > 0 && localTotal > 0) {
    const localOffset = Math.max(0, offset - official.length);
    history = history.concat(queryPublicHistory(db, { q, band, excludeIds, limit: need, offset: localOffset }));
  }
  return { history, page: Math.min(page, pages), pages, total, limit, officialCount: official.length, localCount: localTotal };
}
