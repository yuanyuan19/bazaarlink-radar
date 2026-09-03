import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { dbPathOf } from "../ingest/history.mjs";
import { migrateDb } from "../db/schema.mjs";
import { recordSubmission } from "../core/submissions.mjs";
import { displayScore, fetchOfficialDetails, fetchOfficialRun, liveProgress, startOfficialRun } from "../core/probe-run.mjs";
import { saveAnnotation, saveRunDetails, saveSiteAnnotation } from "../db/repository.mjs";
import { ProbeError, postJson } from "../api/client.mjs";
import { summarizeRun } from "../util.mjs";
import { modelIdsFrom, officialProbeCopy } from "./probe-copy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

function numberParam(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function like(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&")}%`;
}

export function openPlatformDb(flags) {
  const db = new DatabaseSync(dbPathOf(flags));
  migrateDb(db);
  return db;
}

function scoreExpr() {
  return "CASE WHEN rr.score IS NULL THEN NULL WHEN rr.score <= 1 THEN rr.score * 100 ELSE rr.score END";
}

function queryValues(value) {
  if (Array.isArray(value)) return value.flatMap(queryValues).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function dateSince(value) {
  const days = { "24h": 1, "7d": 7, "30d": 30 }[String(value || "")];
  if (!days) return null;
  return new Date(Date.now() - days * 86400000).toISOString();
}

function weekSinceExpr() {
  return "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')";
}

function weekRateSql() {
  return `(
    SELECT ROUND(100.0 * SUM(CASE WHEN rr7.verdict = 'match' THEN 1 ELSE 0 END) /
      NULLIF(SUM(CASE WHEN rr7.verdict IN ('match', 'family_match', 'substitution', 'unknown') THEN 1 ELSE 0 END), 0), 1)
    FROM probe_runs pr7 JOIN probe_results rr7 ON rr7.run_id = pr7.id
    WHERE pr7.site_id = s.id AND pr7.created_at >= ${weekSinceExpr()}
  )`;
}

function runRow(row) {
  const pending = !row.verdict && (
    row.enrichment_status === "pending"
    || row.enrichment_status === "running"
    || (row.enrichment_status == null && row.is_mine === 1)
  );
  return {
    id: row.id,
    host: row.host,
    baseUrl: row.base_url,
    modelId: row.claimed_model_id || row.request_model,
    actualModel: row.actual_model,
    actualFamily: row.actual_family,
    verdict: row.verdict,
    score: row.score,
    displayScore: displayScore(row.score),
    identityConfirmed: row.identity_confirmed === 1,
    confirmedMismatch: row.confirmed_mismatch === 1,
    errorCount: row.error_count,
    createdAt: row.created_at,
    sourceReportUrl: row.source_report_url,
    isMine: row.is_mine === 1,
    note: row.site_note,
    isFavorite: row.site_is_favorite === 1,
    weekRate: row.week_rate == null ? null : Number(row.week_rate),
    pending,
    enrichmentStatus: row.enrichment_status || null,
  };
}

function runQuery(db, { mine, publicOnly, query, host, models, verdicts, scoreMin, scoreMax, since, until, minWeekRate, pending, favorite, limit, offset }) {
  const conditions = [];
  const params = [];
  if (mine) conditions.push("ms.run_id IS NOT NULL");
  if (publicOnly) conditions.push("EXISTS (SELECT 1 FROM run_sources src WHERE src.run_id = pr.id AND src.source_type = 'public_history')");
  if (query) {
    conditions.push("(pr.id LIKE ? ESCAPE '\\' OR s.host LIKE ? ESCAPE '\\' OR pr.claimed_model_id LIKE ? ESCAPE '\\' OR COALESCE(rr.actual_model, '') LIKE ? ESCAPE '\\' OR COALESCE(rr.model_id, '') LIKE ? ESCAPE '\\' OR COALESCE(s.note, '') LIKE ? ESCAPE '\\')");
    params.push(like(query), like(query), like(query), like(query), like(query), like(query));
  }
  if (host) {
    conditions.push("s.host LIKE ? ESCAPE '\\'");
    params.push(like(host));
  }
  const modelValues = queryValues(models);
  if (modelValues.length) {
    conditions.push(`(${modelValues.map(() => "(pr.claimed_model_id = ? OR rr.model_id = ?)").join(" OR ")})`);
    for (const model of modelValues) params.push(model, model);
  }
  const verdictValues = queryValues(verdicts);
  if (pending) {
    conditions.push("(rr.verdict IS NULL AND (ej.status IS NULL OR ej.status != 'completed'))");
  } else if (verdictValues.length) {
    conditions.push(`rr.verdict IN (${verdictValues.map(() => "?").join(",")})`);
    params.push(...verdictValues);
  }
  if (scoreMin !== undefined && scoreMin !== "") {
    conditions.push(`${scoreExpr()} >= ?`);
    params.push(Number(scoreMin));
  }
  if (scoreMax !== undefined && scoreMax !== "") {
    conditions.push(`${scoreExpr()} < ?`);
    params.push(Number(scoreMax));
  }
  const createdSince = dateSince(since);
  if (createdSince) {
    conditions.push("pr.created_at >= ?");
    params.push(createdSince);
  }
  if (until) {
    conditions.push("pr.created_at <= ?");
    params.push(new Date(String(until)).toISOString());
  }
  if (minWeekRate !== undefined && minWeekRate !== "") {
    conditions.push(`${weekRateSql()} >= ?`);
    params.push(Number(minWeekRate));
  }
  if (favorite) conditions.push("s.is_favorite = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const joins = `
    FROM probe_runs pr
    LEFT JOIN sites s ON s.id = pr.site_id
    LEFT JOIN probe_results rr ON rr.run_id = pr.id
    LEFT JOIN my_submissions ms ON ms.run_id = pr.id
    LEFT JOIN run_enrichment_jobs ej ON ej.run_id = pr.id
  `;
  const rows = db.prepare(`
    SELECT pr.id, pr.base_url, pr.claimed_model_id, pr.created_at, pr.source_report_url,
           s.host, rr.model_id, rr.actual_model, rr.actual_family, rr.verdict, rr.score,
           rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
           CASE WHEN ms.run_id IS NULL THEN 0 ELSE 1 END AS is_mine,
           ms.request_model, s.note AS site_note, s.is_favorite AS site_is_favorite,
           ${weekRateSql()} AS week_rate, ej.status AS enrichment_status
    ${joins}
    ${where}
    ORDER BY pr.created_at DESC, pr.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n ${joins} ${where}`).get(...params).n;
  return { rows: rows.map(runRow), total };
}

function runListArgs(request, extra) {
  return {
    query: request.query.q,
    host: request.query.host,
    models: request.query.model,
    verdicts: request.query.verdict,
    scoreMin: request.query.scoreMin,
    scoreMax: request.query.scoreMax,
    since: request.query.since,
    until: request.query.until,
    minWeekRate: request.query.minWeekRate,
    favorite: request.query.favorite === "1",
    limit: numberParam(request.query.limit, 50, 1, 200),
    offset: numberParam(request.query.offset, 0, 0, 10_000_000),
    ...extra,
  };
}

function registerRoutes(app, db, flags = {}, dependencies = {}) {
  app.get("/api/health", async () => {
    const state = db.prepare("SELECT last_success_at, last_error FROM ingest_state WHERE id = 1").get();
    const count = db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n;
    return { status: "ok", database: "ok", records: count, lastSuccessfulIngestAt: state?.last_success_at || null, lastError: state?.last_error || null };
  });

  app.post("/internal/submissions", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "baseUrl"],
        properties: {
          runId: { type: "string", minLength: 1, maxLength: 500 },
          baseUrl: { type: "string", minLength: 1, maxLength: 500 },
          requestModel: { type: "string", maxLength: 500 },
          capturedAt: { type: "string", maxLength: 100 },
          keyAlias: { type: "string", maxLength: 500 },
          keyFingerprint: { type: "string", maxLength: 500 },
          apiGroup: { type: "string", maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const submission = recordSubmission(db, request.body);
      return reply.code(202).send({ accepted: true, runId: submission.runId });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get("/api/my-runs", async (request) => runQuery(db, runListArgs(request, {
    mine: true,
    pending: request.query.pending === "1",
  })));

  app.post("/api/my-runs", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["baseUrl", "apiKey", "modelId"],
        properties: {
          baseUrl: { type: "string", minLength: 1, maxLength: 500 },
          apiKey: { type: "string", minLength: 1, maxLength: 2000 },
          modelId: { type: "string", minLength: 1, maxLength: 500 },
          mode: { type: "string", enum: ["quick", "full", "deep"] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      let parsed;
      try {
        parsed = new URL(request.body.baseUrl);
      } catch {
        return reply.code(400).send({ error: "baseUrl must be a valid URL" });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return reply.code(400).send({ error: "baseUrl must use http or https" });
      }
      const start = dependencies.startOfficialRun || startOfficialRun;
      const { started, runId, body } = await start(request.body, flags, dependencies);
      recordSubmission(db, {
        runId,
        baseUrl: body.baseUrl,
        requestModel: body.modelId,
        apiKey: request.body.apiKey,
      });
      return reply.code(202).send({ accepted: true, runId, status: started.status || "queued" });
    } catch (error) {
      const status = error instanceof ProbeError && error.status >= 400 && error.status < 500 ? error.status : 502;
      return reply.code(error.message.includes("required") || error.message.includes("http") ? 400 : status).send({ error: error.message });
    }
  });

  app.get("/api/public-runs", async (request) => runQuery(db, runListArgs(request, {
    publicOnly: true,
    pending: false,
  })));

  app.get("/api/sites", async (request) => {
    const limit = numberParam(request.query.limit, 50, 1, 200);
    const offset = numberParam(request.query.offset, 0, 0, 10_000_000);
    const conditions = [];
    const params = [];
    if (request.query.q) {
      conditions.push("(s.host LIKE ? ESCAPE '\\' OR COALESCE(s.note, '') LIKE ? ESCAPE '\\')");
      params.push(like(request.query.q), like(request.query.q));
    }
    if (request.query.favorite === "1") conditions.push("s.is_favorite = 1");
    if (request.query.minWeekRate !== undefined && request.query.minWeekRate !== "") {
      conditions.push(`${weekRateSql()} >= ?`);
      params.push(Number(request.query.minWeekRate));
    }
    const siteSince = dateSince(request.query.since);
    if (siteSince) {
      conditions.push("s.last_seen_at >= ?");
      params.push(siteSince);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sortMap = {
      last_seen_at: "s.is_favorite DESC, last_seen_at DESC, s.host",
      run_count: "s.is_favorite DESC, run_count DESC, s.host",
      match_count: "s.is_favorite DESC, match_count DESC, s.host",
      substitution_count: "s.is_favorite DESC, substitution_count DESC, s.host",
      error_count: "s.is_favorite DESC, error_count DESC, s.host",
      model_count: "s.is_favorite DESC, model_count DESC, s.host",
      week_count: "s.is_favorite DESC, week_count DESC, s.host",
      week_rate: "s.is_favorite DESC, week_rate DESC, s.host",
      host: "s.is_favorite DESC, s.host",
      favorite: "s.is_favorite DESC, last_seen_at DESC, s.host",
    };
    const order = sortMap[request.query.sort] || sortMap.last_seen_at;
    const rows = db.prepare(`
        SELECT s.host, s.base_url, s.first_seen_at, s.last_seen_at, s.note, s.is_favorite,
               COUNT(DISTINCT pr.id) AS run_count, COUNT(DISTINCT rr.model_id) AS model_count,
               SUM(CASE WHEN pr.created_at >= ${weekSinceExpr()} THEN 1 ELSE 0 END) AS week_count,
               ${weekRateSql()} AS week_rate,
               SUM(CASE WHEN rr.verdict = 'match' THEN 1 ELSE 0 END) AS match_count,
               SUM(CASE WHEN rr.verdict = 'substitution' THEN 1 ELSE 0 END) AS substitution_count,
               SUM(COALESCE(rr.error_count, 0)) AS error_count
        FROM sites s
        LEFT JOIN probe_runs pr ON pr.site_id = s.id
        LEFT JOIN probe_results rr ON rr.run_id = pr.id
        ${where}
        GROUP BY s.id
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM sites s ${where}`).get(...params).n;
    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        isFavorite: row.is_favorite === 1,
        note: row.note || null,
        weekCount: row.week_count || 0,
        weekRate: row.week_rate == null ? null : Number(row.week_rate),
      })),
    };
  });

  app.get("/api/sites/:host", async (request, reply) => {
    const site = db.prepare("SELECT * FROM sites WHERE host = ?").get(request.params.host);
    if (!site) return reply.code(404).send({ error: "site not found" });
    const models = db.prepare(`
      SELECT rr.model_id, rr.actual_model, rr.actual_family,
             COUNT(*) AS sample_count,
             SUM(CASE WHEN rr.verdict = 'match' THEN 1 ELSE 0 END) AS match_count,
             SUM(CASE WHEN rr.verdict = 'substitution' THEN 1 ELSE 0 END) AS substitution_count,
             AVG(rr.score) AS average_score, MAX(pr.created_at) AS last_seen_at
      FROM probe_runs pr
      JOIN probe_results rr ON rr.run_id = pr.id
      WHERE pr.site_id = ?
      GROUP BY rr.model_id, rr.actual_model, rr.actual_family
      ORDER BY sample_count DESC, rr.model_id
    `).all(site.id);
    const overview = db.prepare(`
      SELECT COUNT(*) AS total_count,
             SUM(CASE WHEN pr.created_at >= ${weekSinceExpr()} THEN 1 ELSE 0 END) AS week_count,
             ROUND(100.0 * SUM(CASE WHEN pr.created_at >= ${weekSinceExpr()} AND rr.verdict = 'match' THEN 1 ELSE 0 END) /
               NULLIF(SUM(CASE WHEN pr.created_at >= ${weekSinceExpr()} AND rr.verdict IN ('match', 'family_match', 'substitution', 'unknown') THEN 1 ELSE 0 END), 0), 1) AS week_rate,
             ROUND(100.0 * SUM(CASE WHEN rr.verdict = 'match' THEN 1 ELSE 0 END) /
               NULLIF(SUM(CASE WHEN rr.verdict IN ('match', 'family_match', 'substitution', 'unknown') THEN 1 ELSE 0 END), 0), 1) AS total_rate
      FROM probe_runs pr JOIN probe_results rr ON rr.run_id = pr.id WHERE pr.site_id = ?
    `).get(site.id);
    return {
      site: { ...site, isFavorite: site.is_favorite === 1 },
      overview,
      models,
    };
  });

  app.patch("/api/sites/:host", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: "string", maxLength: 4000 },
          isFavorite: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const saved = saveSiteAnnotation(db, request.params.host, request.body || {});
    if (!saved) return reply.code(404).send({ error: "site not found" });
    return saved;
  });

  app.get("/api/probe-copy", async () => officialProbeCopy);

  app.get("/api/filters", async () => ({
    models: db.prepare(`
      SELECT m.id, COUNT(rr.run_id) AS count
      FROM models m LEFT JOIN probe_results rr ON rr.model_id = m.id
      GROUP BY m.id ORDER BY count DESC, m.id
    `).all(),
  }));

  app.post("/api/endpoint-models", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["baseUrl", "apiKey"],
        properties: {
          baseUrl: { type: "string", minLength: 1, maxLength: 500 },
          apiKey: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const post = dependencies.postJson || postJson;
      const payload = await post(flags, "/api/probe/models", {
        baseUrl: request.body.baseUrl,
        apiKey: request.body.apiKey,
      }, 30_000);
      return { models: modelIdsFrom(payload) };
    } catch (error) {
      const status = error instanceof ProbeError && error.status >= 400 && error.status < 500 ? error.status : 502;
      return reply.code(status).send({ error: error.message, models: [] });
    }
  });

  app.get("/api/models", async () => ({
    rows: db.prepare(`
      SELECT m.id, m.display_name, m.family, m.first_seen_at, m.last_seen_at,
             COUNT(DISTINCT pr.site_id) AS site_count, COUNT(rr.run_id) AS sample_count
      FROM models m
      LEFT JOIN probe_results rr ON rr.model_id = m.id
      LEFT JOIN probe_runs pr ON pr.id = rr.run_id
      GROUP BY m.id
      ORDER BY sample_count DESC, m.id
    `).all(),
  }));

  app.get("/api/models/:modelId", async (request, reply) => {
    const model = db.prepare("SELECT * FROM models WHERE id = ?").get(request.params.modelId);
    if (!model) return reply.code(404).send({ error: "model not found" });
    const sites = db.prepare(`
      SELECT s.host, COUNT(*) AS sample_count,
             SUM(CASE WHEN rr.verdict = 'match' THEN 1 ELSE 0 END) AS match_count,
             SUM(CASE WHEN rr.verdict = 'substitution' THEN 1 ELSE 0 END) AS substitution_count,
             AVG(rr.score) AS average_score, MAX(pr.created_at) AS last_seen_at
      FROM probe_results rr
      JOIN probe_runs pr ON pr.id = rr.run_id
      JOIN sites s ON s.id = pr.site_id
      WHERE rr.model_id = ?
      GROUP BY s.id
      ORDER BY sample_count DESC, s.host
    `).all(request.params.modelId);
    return { model, sites };
  });

  app.get("/api/ingest/status", async () => {
    const state = db.prepare(`
      SELECT next_poll_at, current_interval_ms, last_poll_at, last_success_at, last_error
      FROM ingest_state WHERE id = 1
    `).get();
    const recent = db.prepare("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 10").all();
    return { state, recent };
  });

  app.get("/api/runs/:id/live", async (request, reply) => {
    const existing = db.prepare("SELECT id FROM probe_runs WHERE id = ?").get(request.params.id);
    if (!existing) return reply.code(404).send({ error: "run not found" });
    try {
      const fetchLive = dependencies.fetchOfficialRun || fetchOfficialRun;
      const live = await fetchLive(request.params.id, flags, dependencies);
      const status = live?.status || (live?.completedAt ? "completed" : "running");
      if (status === "completed" || status === "failed" || live?.completedAt) {
        const fetchDetails = dependencies.fetchOfficialDetails || fetchOfficialDetails;
        try {
          const details = await fetchDetails(request.params.id, flags, dependencies);
          saveRunDetails(db, { ...details, id: details?.id || details?.runId || request.params.id });
        } catch {
          if (live) saveRunDetails(db, { ...live, id: live.id || live.runId || request.params.id });
        }
      }
      const progress = liveProgress(live);
      return {
        id: request.params.id,
        status,
        score: live?.score ?? null,
        displayScore: displayScore(live?.score),
        progress,
        summary: live ? summarizeRun(live) : null,
      };
    } catch (error) {
      return reply.code(502).send({ error: error.message, id: request.params.id });
    }
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const row = db.prepare(`
        SELECT pr.*, s.host, s.note AS site_note, s.is_favorite AS site_is_favorite,
               rr.model_id, rr.actual_model, rr.actual_family, rr.verdict,
               rr.score, rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
               rr.input_tokens, rr.output_tokens, ms.key_alias, ms.api_group,
               ra.note, ra.custom_tags, ra.conclusion, ra.is_favorite
        FROM probe_runs pr
        LEFT JOIN sites s ON s.id = pr.site_id
        LEFT JOIN probe_results rr ON rr.run_id = pr.id
        LEFT JOIN my_submissions ms ON ms.run_id = pr.id
        LEFT JOIN run_annotations ra ON ra.run_id = pr.id
        WHERE pr.id = ?
      `).get(request.params.id);
    if (!row) return reply.code(404).send({ error: "run not found" });
    return { ...row, siteNote: row.site_note || null, siteIsFavorite: row.site_is_favorite === 1 };
  });

  app.patch("/api/runs/:id/annotation", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: "string", maxLength: 4000 },
          tags: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 40 } },
          conclusion: { type: "string", enum: ["trusted", "suspicious", "rejected", "unset"] },
          isFavorite: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const exists = db.prepare("SELECT 1 FROM probe_runs WHERE id = ?").get(request.params.id);
    if (!exists) return reply.code(404).send({ error: "run not found" });
    return saveAnnotation(db, request.params.id, request.body || {});
  });
}

export function buildPlatform(flags = {}, dependencies = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  const db = openPlatformDb(flags);
  app.addHook("onClose", async () => db.close());
  registerRoutes(app, db, flags, dependencies);
  app.get("/", async (_, reply) => reply.type("text/html; charset=utf-8").send(fs.readFileSync(path.join(publicDir, "index.html"), "utf8")));
  app.get("/tokens.css", async (_, reply) => reply.type("text/css; charset=utf-8").send(fs.readFileSync(path.join(publicDir, "tokens.css"), "utf8")));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.type("text/html; charset=utf-8").send(fs.readFileSync(path.join(publicDir, "index.html"), "utf8"));
  });
  return app;
}

export async function startPlatform(flags = {}) {
  const app = buildPlatform(flags);
  const host = String(flags.host || process.env.PLATFORM_HOST || "0.0.0.0");
  const port = Number(flags.port || process.env.PLATFORM_PORT || 3000);
  await app.listen({ host, port });
  process.stderr.write(`platform listening on http://${host}:${port}\n`);
}
