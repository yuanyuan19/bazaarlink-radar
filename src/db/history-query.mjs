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

function isRunningRow(row) {
  if (row.done_probes != null && row.total_probes != null) {
    return Number(row.done_probes) < Number(row.total_probes);
  }
  if (row.enrichment_status === "pending" || row.enrichment_status === "running") return true;
  return row.verdict == null && row.is_mine === 1;
}

export function toHistoryApiRow(row) {
  const running = isRunningRow(row);
  const scoreRaw = row.score;
  return {
    id: row.id,
    baseUrl: row.base_url,
    modelId: row.claimed_model_id || row.request_model || row.model_id || null,
    score: normalizeApiScore(scoreRaw),
    createdAt: row.created_at,
    identityConfirmed: row.identity_confirmed === 1,
    confirmedMismatch: row.confirmed_mismatch === 1,
    mostSimilarDisplayName: row.actual_model || null,
    identityOnly: row.identity_only === 1,
    errorCount: row.error_count ?? 0,
    totalProbes: row.total_probes ?? null,
    doneProbes: running ? row.done_probes ?? 0 : row.done_probes ?? null,
    host: row.host || hostFromUrl(row.base_url),
    displayScore: displayScore(scoreRaw),
    source: "local",
  };
}

function bandConditions(band) {
  const score = scoreExpr();
  switch (String(band || "all")) {
    case "80":
      return [`${score} >= 80`, []];
    case "50":
      return [`${score} >= 50`, []];
    case "low":
      return [`${score} < 50 AND ${score} IS NOT NULL`, []];
    case "running":
      return ["(rr.verdict IS NULL OR ej.status IN ('pending', 'running'))", []];
    default:
      return [null, []];
  }
}

function excludeIdConditions(excludeIds) {
  const ids = [...new Set((excludeIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { clause: "", params: [] };
  const limited = ids.slice(0, 500);
  return {
    clause: `pr.id NOT IN (${limited.map(() => "?").join(",")})`,
    params: limited,
  };
}

export function queryPublicHistory(db, options = {}) {
  const {
    q,
    band = "all",
    limit = 50,
    offset = 0,
    excludeIds = [],
  } = options;

  const conditions = [
    "EXISTS (SELECT 1 FROM run_sources src WHERE src.run_id = pr.id AND src.source_type = 'public_history')",
  ];
  const params = [];

  if (q) {
    conditions.push("(pr.id LIKE ? ESCAPE '\\' OR s.host LIKE ? ESCAPE '\\' OR pr.claimed_model_id LIKE ? ESCAPE '\\' OR COALESCE(rr.actual_model, '') LIKE ? ESCAPE '\\' OR COALESCE(rr.model_id, '') LIKE ? ESCAPE '\\' OR pr.base_url LIKE ? ESCAPE '\\')");
    params.push(like(q), like(q), like(q), like(q), like(q), like(q));
  }

  const [bandClause] = bandConditions(band);
  if (bandClause) conditions.push(bandClause);

  const exclude = excludeIdConditions(excludeIds);
  if (exclude.clause) {
    conditions.push(exclude.clause);
    params.push(...exclude.params);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const joins = `
    FROM probe_runs pr
    LEFT JOIN sites s ON s.id = pr.site_id
    LEFT JOIN probe_results rr ON rr.run_id = pr.id
    LEFT JOIN my_submissions ms ON ms.run_id = pr.id
    LEFT JOIN run_enrichment_jobs ej ON ej.run_id = pr.id
  `;

  const rows = db.prepare(`
    SELECT pr.id, pr.base_url, pr.claimed_model_id, pr.created_at,
           s.host, rr.model_id, rr.actual_model, rr.verdict, rr.score,
           rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
           ms.request_model, ej.status AS enrichment_status,
           CASE WHEN ms.run_id IS NULL THEN 0 ELSE 1 END AS is_mine,
           NULL AS identity_only, NULL AS total_probes, NULL AS done_probes
    ${joins}
    ${where}
    ORDER BY pr.created_at DESC, pr.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS n ${joins} ${where}`).get(...params).n;
  return {
    history: rows.map(toHistoryApiRow),
    total,
    offset,
    limit,
  };
}

export function bootPublicHistory(db, limit = 48, excludeIds = []) {
  return queryPublicHistory(db, { limit, offset: 0, excludeIds, band: "all" });
}
