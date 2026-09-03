import { displayScore } from "../core/probe-run.mjs";
import { hostFromUrl } from "../util.mjs";

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

export function toHistoryApiRow(row) {
  return {
    id: row.id,
    runUuid: row.run_uuid || null,
    baseUrl: row.base_url,
    modelId: row.claimed_model_id || row.request_model || row.model_id || null,
    score: normalizeApiScore(row.score),
    createdAt: row.created_at,
    identityConfirmed: row.identity_confirmed === 1,
    confirmedMismatch: row.confirmed_mismatch === 1,
    mostSimilarDisplayName: row.actual_model || null,
    identityOnly: false,
    errorCount: row.error_count ?? 0,
    totalProbes: null,
    doneProbes: null,
    host: row.host || hostFromUrl(row.base_url),
    displayScore: displayScore(row.score),
    source: "local",
  };
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
      // 本地库只存已完成的公开记录，进行中的行只来自官方窗口。
      return "0";
    default:
      return null;
  }
}

// 游标是 "<created_at>|<id>"，按 (created_at DESC, id DESC) 严格单调，翻页不重不漏。
export function encodeCursor(row) {
  if (!row) return null;
  return `${row.createdAt || ""}|${row.id}`;
}

export function decodeCursor(value) {
  if (!value) return null;
  const raw = String(value);
  const at = raw.lastIndexOf("|");
  if (at < 0) return null;
  const createdAt = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!id) return null;
  return { createdAt, id };
}

export function queryPublicHistory(db, options = {}) {
  const { q, band = "all", after } = options;
  const limit = numberParam(options.limit, 50, 1, 200);

  const conditions = [
    "EXISTS (SELECT 1 FROM run_sources src WHERE src.run_id = pr.id AND src.source_type = 'public_history')",
  ];
  const params = [];

  if (q) {
    conditions.push("(pr.id LIKE ? ESCAPE '\\' OR s.host LIKE ? ESCAPE '\\' OR pr.claimed_model_id LIKE ? ESCAPE '\\' OR COALESCE(rr.actual_model, '') LIKE ? ESCAPE '\\' OR COALESCE(rr.model_id, '') LIKE ? ESCAPE '\\' OR pr.base_url LIKE ? ESCAPE '\\')");
    params.push(like(q), like(q), like(q), like(q), like(q), like(q));
  }

  const bandSql = bandClause(band);
  if (bandSql) conditions.push(bandSql);

  const cursor = decodeCursor(after);
  if (cursor) {
    conditions.push("(COALESCE(pr.created_at, '') < ? OR (COALESCE(pr.created_at, '') = ? AND pr.id < ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const rows = db.prepare(`
    SELECT pr.id, pr.run_uuid, pr.base_url, pr.claimed_model_id, pr.created_at,
           s.host, rr.model_id, rr.actual_model, rr.verdict, rr.score,
           rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
           ms.request_model
    FROM probe_runs pr
    LEFT JOIN sites s ON s.id = pr.site_id
    LEFT JOIN probe_results rr ON rr.run_id = pr.id
    LEFT JOIN my_submissions ms ON ms.run_id = pr.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY COALESCE(pr.created_at, '') DESC, pr.id DESC
    LIMIT ?
  `).all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(toHistoryApiRow);
  return {
    history: page,
    limit,
    hasMore,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export function bootPublicHistory(db, limit = 48) {
  return queryPublicHistory(db, { limit, band: "all" });
}
