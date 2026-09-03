import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { dbPathOf } from "../ingest/history.mjs";
import { migrateDb } from "../db/schema.mjs";
import { recordSubmission } from "../core/submissions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

function numberParam(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function like(value) {
  return `%${String(value || "").replace(/[\\%_]/g, "\\$&").replace(/'/g, "''")}%`;
}

export function openPlatformDb(flags) {
  const db = new DatabaseSync(dbPathOf(flags));
  migrateDb(db);
  return db;
}

function runRow(row) {
  return {
    id: row.id,
    host: row.host,
    baseUrl: row.base_url,
    modelId: row.claimed_model_id,
    actualModel: row.actual_model,
    actualFamily: row.actual_family,
    verdict: row.verdict,
    score: row.score,
    identityConfirmed: row.identity_confirmed === 1,
    confirmedMismatch: row.confirmed_mismatch === 1,
    errorCount: row.error_count,
    createdAt: row.created_at,
    sourceReportUrl: row.source_report_url,
    isMine: row.is_mine === 1,
    note: row.note,
    isFavorite: row.is_favorite === 1,
  };
}

function runQuery(db, { mine, publicOnly, query, host, model, verdict, limit, offset }) {
  const conditions = [];
  const params = [];
  if (mine) conditions.push("ms.run_id IS NOT NULL");
  if (publicOnly) conditions.push("EXISTS (SELECT 1 FROM run_sources src WHERE src.run_id = pr.id AND src.source_type = 'public_history')");
  if (query) {
    conditions.push("(pr.id LIKE ? ESCAPE '\\' OR s.host LIKE ? ESCAPE '\\' OR pr.claimed_model_id LIKE ? ESCAPE '\\')");
    params.push(like(query), like(query), like(query));
  }
  if (host) {
    conditions.push("s.host LIKE ? ESCAPE '\\'");
    params.push(like(host));
  }
  if (model) {
    conditions.push("(pr.claimed_model_id = ? OR rr.model_id = ?)");
    params.push(model, model);
  }
  if (verdict) {
    conditions.push("rr.verdict = ?");
    params.push(verdict);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT pr.id, pr.base_url, pr.claimed_model_id, pr.created_at, pr.source_report_url,
           s.host, rr.model_id, rr.actual_model, rr.actual_family, rr.verdict, rr.score,
           rr.identity_confirmed, rr.confirmed_mismatch, rr.error_count,
           CASE WHEN ms.run_id IS NULL THEN 0 ELSE 1 END AS is_mine,
           ra.note, ra.is_favorite
    FROM probe_runs pr
    LEFT JOIN sites s ON s.id = pr.site_id
    LEFT JOIN probe_results rr ON rr.run_id = pr.id
    LEFT JOIN my_submissions ms ON ms.run_id = pr.id
    LEFT JOIN run_annotations ra ON ra.run_id = pr.id
    ${where}
    ORDER BY pr.created_at DESC, pr.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS n
    FROM probe_runs pr
    LEFT JOIN sites s ON s.id = pr.site_id
    LEFT JOIN probe_results rr ON rr.run_id = pr.id
    LEFT JOIN my_submissions ms ON ms.run_id = pr.id
    ${where}
  `).get(...params).n;
  return { rows: rows.map(runRow), total };
}

function registerRoutes(app, db) {
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

  app.get("/api/my-runs", async (request) => {
    const limit = numberParam(request.query.limit, 50, 1, 200);
    const offset = numberParam(request.query.offset, 0, 0, 10_000_000);
    return runQuery(db, { mine: true, query: request.query.q, host: request.query.host, model: request.query.model, verdict: request.query.verdict, limit, offset });
  });

  app.get("/api/public-runs", async (request) => {
    const limit = numberParam(request.query.limit, 50, 1, 200);
    const offset = numberParam(request.query.offset, 0, 0, 10_000_000);
    return runQuery(db, { publicOnly: true, query: request.query.q, host: request.query.host, model: request.query.model, verdict: request.query.verdict, limit, offset });
  });

  app.get("/api/sites", async (request) => {
    const limit = numberParam(request.query.limit, 50, 1, 200);
    const offset = numberParam(request.query.offset, 0, 0, 10_000_000);
    const q = request.query.q ? "WHERE s.host LIKE ? ESCAPE '\\'" : "";
    const params = request.query.q ? [like(request.query.q)] : [];
    const rows = db.prepare(`
        SELECT s.host, s.base_url, s.first_seen_at, s.last_seen_at,
               COUNT(DISTINCT pr.id) AS run_count, COUNT(DISTINCT rr.model_id) AS model_count,
               SUM(CASE WHEN rr.verdict = 'substitution' THEN 1 ELSE 0 END) AS substitution_count,
               SUM(COALESCE(rr.error_count, 0)) AS error_count
        FROM sites s
        LEFT JOIN probe_runs pr ON pr.site_id = s.id
        LEFT JOIN probe_results rr ON rr.run_id = pr.id
        ${q}
        GROUP BY s.id
        ORDER BY last_seen_at DESC, s.host
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM sites s ${q}`).get(...params).n;
    return { total, rows };
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
    return { site, models };
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

  app.get("/api/aggregates/timeseries", async (request) => {
    const conditions = [];
    const params = [];
    if (request.query.host) {
      conditions.push("s.host = ?");
      params.push(request.query.host);
    }
    if (request.query.model) {
      conditions.push("rr.model_id = ?");
      params.push(request.query.model);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT substr(pr.created_at, 1, 10) AS day, COUNT(*) AS sample_count,
             SUM(CASE WHEN rr.verdict = 'match' THEN 1 ELSE 0 END) AS match_count,
             SUM(CASE WHEN rr.verdict = 'substitution' THEN 1 ELSE 0 END) AS substitution_count,
             SUM(CASE WHEN rr.verdict = 'error' THEN 1 ELSE 0 END) AS error_count,
             AVG(rr.score) AS average_score
      FROM probe_runs pr
      JOIN probe_results rr ON rr.run_id = pr.id
      JOIN sites s ON s.id = pr.site_id
      ${where}
      GROUP BY day
      ORDER BY day
    `).all(...params);
    return { rows };
  });

  app.get("/api/ingest/status", async () => {
    const state = db.prepare(`
      SELECT next_poll_at, current_interval_ms, last_poll_at, last_success_at, last_error
      FROM ingest_state WHERE id = 1
    `).get();
    const recent = db.prepare("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 10").all();
    return { state, recent };
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const row = db.prepare(`
        SELECT pr.*, s.host, rr.model_id, rr.actual_model, rr.actual_family, rr.verdict,
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
    return row;
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
    const current = db.prepare("SELECT * FROM run_annotations WHERE run_id = ?").get(request.params.id);
    const body = request.body || {};
    const note = body.note ?? current?.note ?? null;
    const tags = body.tags ? JSON.stringify([...new Set(body.tags)]) : current?.custom_tags ?? "[]";
    const conclusion = body.conclusion ?? current?.conclusion ?? "unset";
    const favorite = body.isFavorite === undefined ? current?.is_favorite ?? 0 : body.isFavorite ? 1 : 0;
    const updatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO run_annotations(run_id, note, custom_tags, conclusion, is_favorite, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET note = excluded.note, custom_tags = excluded.custom_tags,
        conclusion = excluded.conclusion, is_favorite = excluded.is_favorite, updated_at = excluded.updated_at
    `).run(request.params.id, note, tags, conclusion, favorite, updatedAt);
    return { runId: request.params.id, note, tags: JSON.parse(tags), conclusion, isFavorite: favorite === 1, updatedAt };
  });
}

export function buildPlatform(flags = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  const db = openPlatformDb(flags);
  app.addHook("onClose", async () => db.close());
  registerRoutes(app, db);
  app.get("/", async (_, reply) => reply.type("text/html; charset=utf-8").send(fs.readFileSync(path.join(publicDir, "index.html"), "utf8")));
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
