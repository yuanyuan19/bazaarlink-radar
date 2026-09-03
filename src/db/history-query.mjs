export function numberParam(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function like(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&")}%`;
}

// 官方 history 接口的 score 是 0–100；老库里 0–1 的值按比例还原。
const SCORE = "CASE WHEN rr.score IS NULL THEN NULL WHEN rr.score <= 1 AND rr.score > 0 THEN rr.score * 100 ELSE rr.score END";

// 每一项与官方 /api/probe/history 同形，官方 React 组件原样渲染。
export function toHistoryApiRow(row) {
  return {
    id: row.id,
    runId: row.run_uuid || undefined,
    baseUrl: row.base_url,
    modelId: row.claimed_model_id || row.request_model || row.model_id || null,
    score: row.score_100 == null ? null : Math.round(Number(row.score_100)),
    createdAt: row.created_at,
    identityConfirmed: row.identity_confirmed === 1,
    confirmedMismatch: row.confirmed_mismatch === 1,
    mostSimilarDisplayName: row.actual_model || null,
    errorCount: row.error_count ?? 0,
    identityOnly: row.identity_only === 1,
    totalProbes: row.total_probes ?? undefined,
  };
}

function bandClause(band) {
  switch (String(band || "all")) {
    case "80":
      return `${SCORE} >= 80`;
    case "50":
      return `${SCORE} >= 50`;
    case "low":
      return `${SCORE} IS NOT NULL AND ${SCORE} < 50`;
    case "running":
      // 进行中的行只来自官方 /api/probe/active，本地库里没有。
      return "0";
    default:
      return null;
  }
}

const JOINS = `
  FROM probe_runs pr
  LEFT JOIN probe_results rr ON rr.run_id = pr.id
  LEFT JOIN my_submissions ms ON ms.run_id = pr.id
`;

function buildWhere({ q, band }) {
  const conditions = ["pr.is_public = 1"];
  const params = [];
  if (q) {
    conditions.push("(pr.base_url LIKE ? ESCAPE '\\' OR COALESCE(pr.claimed_model_id, '') LIKE ? ESCAPE '\\')");
    params.push(like(q), like(q));
  }
  const bandSql = bandClause(band);
  if (bandSql) conditions.push(bandSql);
  return { conditions, params };
}

export function latestIngestedAt(db) {
  return db.prepare("SELECT MAX(ingested_at) AS at FROM probe_runs").get()?.at || null;
}

// 快照分页：asOf 是进入列表时的入库时刻。翻页只在 ingested_at <= asOf 的集合上进行，
// 之后新入库的记录只计数（newerCount），用户点“新记录”才换锚点。列表只增不减，翻页不重不漏。
export function historyPage(db, options = {}) {
  const limit = numberParam(options.limit, 50, 1, 200);
  const wanted = numberParam(options.page, 1, 1, 100_000);
  const q = String(options.q || "").trim();
  const band = String(options.band || "all");
  const asOf = options.asOf ? String(options.asOf) : latestIngestedAt(db) || new Date().toISOString();

  const { conditions, params } = buildWhere({ q, band });
  const snapshotWhere = `WHERE ${[...conditions, "pr.ingested_at <= ?"].join(" AND ")}`;
  const newerWhere = `WHERE ${[...conditions, "pr.ingested_at > ?"].join(" AND ")}`;

  // 无筛选时 COUNT 只碰 probe_runs，走 (ingested_at, is_public) 覆盖索引；有筛选才 JOIN。
  const countJoins = q || bandClause(band) ? JOINS : "FROM probe_runs pr";
  const total = db.prepare(`SELECT COUNT(*) AS n ${countJoins} ${snapshotWhere}`).get(...params, asOf).n;
  const newerCount = db.prepare(`SELECT COUNT(*) AS n ${countJoins} ${newerWhere}`).get(...params, asOf).n;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(wanted, pages);

  const rows = db.prepare(`
    SELECT pr.id, pr.run_uuid, pr.base_url, pr.claimed_model_id, pr.created_at,
           rr.model_id, rr.actual_model, rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
           rr.identity_only, rr.total_probes, ${SCORE} AS score_100, ms.request_model
    ${JOINS}
    ${snapshotWhere}
    ORDER BY pr.created_at DESC, pr.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, asOf, limit, (page - 1) * limit);

  return { history: rows.map(toHistoryApiRow), page, pages, total, limit, asOf, newerCount };
}
