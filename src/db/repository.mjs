import { hostFromUrl } from "../util.mjs";

function bool01(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

function siteFor(db, item, now) {
  const host = hostFromUrl(item.baseUrl);
  db.prepare(`
    INSERT INTO sites(host, base_url, first_seen_at, last_seen_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET
      base_url = COALESCE(excluded.base_url, sites.base_url),
      last_seen_at = excluded.last_seen_at
  `).run(host, item.baseUrl ?? null, now, now);
  return db.prepare("SELECT id FROM sites WHERE host = ?").get(host).id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHILD_TABLES = ["probe_results", "run_sources", "my_submissions", "run_enrichment_jobs", "run_annotations"];

export function isRunUuid(value) {
  return UUID_RE.test(String(value || ""));
}

// 自己提交的检测先以 UUID（runId）落库；官方入库后主键变成 CUID（id）。
// 拿到两者对应关系时把整条记录连同子表换到 CUID 键上，保证一次检测只有一行。
export function rekeyRun(db, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  const old = db.prepare("SELECT * FROM probe_runs WHERE id = ?").get(String(fromId));
  if (!old) return false;
  db.exec("SAVEPOINT rekey_run");
  try {
    db.prepare("UPDATE probe_runs SET run_uuid = NULL WHERE id = ?").run(String(fromId));
    db.prepare(`
      INSERT INTO probe_runs(id, base_url, site_id, claimed_model_id, created_at, completed_at,
        source_report_url, raw_payload_ref, parser_version, ingested_at, run_uuid)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = COALESCE(probe_runs.base_url, excluded.base_url),
        site_id = COALESCE(probe_runs.site_id, excluded.site_id),
        claimed_model_id = COALESCE(probe_runs.claimed_model_id, excluded.claimed_model_id),
        created_at = COALESCE(probe_runs.created_at, excluded.created_at),
        completed_at = COALESCE(probe_runs.completed_at, excluded.completed_at),
        run_uuid = COALESCE(probe_runs.run_uuid, excluded.run_uuid)
    `).run(
      String(toId), old.base_url, old.site_id, old.claimed_model_id, old.created_at, old.completed_at,
      `https://bazaarlink.ai/probe?runId=${encodeURIComponent(toId)}`, old.raw_payload_ref, old.parser_version, old.ingested_at,
      old.run_uuid || (isRunUuid(fromId) ? String(fromId) : null),
    );
    for (const table of CHILD_TABLES) {
      db.prepare(`UPDATE OR IGNORE ${table} SET run_id = ? WHERE run_id = ?`).run(String(toId), String(fromId));
    }
    db.prepare("DELETE FROM probe_runs WHERE id = ?").run(String(fromId));
    db.exec("RELEASE rekey_run");
    return true;
  } catch (error) {
    db.exec("ROLLBACK TO rekey_run");
    db.exec("RELEASE rekey_run");
    throw error;
  }
}

export function savePublicObservation(db, item, now, { sourceType = "public_history" } = {}) {
  if (!item?.id) return false;
  const runUuid = item.runId && isRunUuid(item.runId) && String(item.runId) !== String(item.id) ? String(item.runId) : null;
  if (runUuid) rekeyRun(db, runUuid, String(item.id));
  const siteId = siteFor(db, item, now);
  db.prepare(`
    INSERT INTO probe_runs(
      id, base_url, site_id, claimed_model_id, created_at,
      completed_at, source_report_url, raw_payload_ref, parser_version, ingested_at, run_uuid
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_url = COALESCE(excluded.base_url, probe_runs.base_url),
      site_id = COALESCE(excluded.site_id, probe_runs.site_id),
      claimed_model_id = COALESCE(excluded.claimed_model_id, probe_runs.claimed_model_id),
      completed_at = COALESCE(excluded.completed_at, probe_runs.completed_at),
      run_uuid = COALESCE(probe_runs.run_uuid, excluded.run_uuid)
  `).run(
    String(item.id), item.baseUrl ?? null, siteId, item.modelId ?? null, item.createdAt ?? null,
    item.completedAt ?? null, `https://bazaarlink.ai/probe?runId=${encodeURIComponent(item.id)}`, null, "history-v1", now, runUuid,
  );

  const modelId = item.modelId ?? item.v4ModelId ?? item.v3fModelId ?? null;
  if (modelId) {
    db.prepare(`
      INSERT INTO models(id, display_name, family, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, models.display_name),
        family = COALESCE(excluded.family, models.family),
        last_seen_at = excluded.last_seen_at
    `).run(modelId, item.v4DisplayName ?? item.v3fDisplayName ?? null, item.predictedFamily ?? null, now, now);
  }

  db.prepare(`
    INSERT INTO probe_results(
      run_id, model_id, actual_model, actual_family, verdict, score,
      identity_confirmed, confirmed_mismatch, error_count, input_tokens, output_tokens
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      model_id = COALESCE(excluded.model_id, probe_results.model_id),
      actual_model = COALESCE(excluded.actual_model, probe_results.actual_model),
      actual_family = COALESCE(excluded.actual_family, probe_results.actual_family),
      verdict = COALESCE(excluded.verdict, probe_results.verdict),
      score = COALESCE(excluded.score, probe_results.score),
      identity_confirmed = COALESCE(excluded.identity_confirmed, probe_results.identity_confirmed),
      confirmed_mismatch = COALESCE(excluded.confirmed_mismatch, probe_results.confirmed_mismatch),
      error_count = COALESCE(excluded.error_count, probe_results.error_count),
      input_tokens = COALESCE(excluded.input_tokens, probe_results.input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, probe_results.output_tokens)
  `).run(
    String(item.id), modelId, item.v4ModelId ?? item.v3fModelId ?? null,
    item.predictedFamily ?? item.mostSimilarFamily ?? null,
    item.confirmedMismatch ? "substitution" : item.identityConfirmed ? "match" : "unknown",
    item.score ?? null, bool01(item.identityConfirmed), bool01(item.confirmedMismatch),
    item.errorCount ?? null, item.totalInputTokens ?? null, item.totalOutputTokens ?? null,
  );

  if (sourceType) {
    db.prepare(`
      INSERT INTO run_sources(run_id, source_type, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(run_id, source_type) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(String(item.id), sourceType, now, now);
  }
  return true;
}

export function saveMySubmission(db, submission, now = new Date().toISOString()) {
  if (!submission?.runId || !submission?.baseUrl) return false;
  const runId = String(submission.runId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const siteId = siteFor(db, { baseUrl: submission.baseUrl }, now);
    db.prepare(`
      INSERT INTO probe_runs(
        id, base_url, site_id, claimed_model_id, created_at,
        source_report_url, parser_version, ingested_at, run_uuid
      ) VALUES(?, ?, ?, ?, ?, ?, 'submission-v1', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = COALESCE(probe_runs.base_url, excluded.base_url),
        site_id = COALESCE(probe_runs.site_id, excluded.site_id),
        claimed_model_id = COALESCE(probe_runs.claimed_model_id, excluded.claimed_model_id),
        created_at = COALESCE(probe_runs.created_at, excluded.created_at),
        source_report_url = COALESCE(probe_runs.source_report_url, excluded.source_report_url),
        run_uuid = COALESCE(probe_runs.run_uuid, excluded.run_uuid)
    `).run(
      runId, submission.baseUrl, siteId, submission.requestModel ?? null,
      submission.capturedAt ?? now,
      `https://bazaarlink.ai/probe?runId=${encodeURIComponent(runId)}`,
      now, isRunUuid(runId) ? runId : null,
    );
    db.prepare(`
      INSERT INTO my_submissions(run_id, captured_at, key_alias, key_fingerprint, api_group, request_model)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        key_alias = COALESCE(excluded.key_alias, my_submissions.key_alias),
        key_fingerprint = COALESCE(excluded.key_fingerprint, my_submissions.key_fingerprint),
        api_group = COALESCE(excluded.api_group, my_submissions.api_group),
        request_model = COALESCE(excluded.request_model, my_submissions.request_model)
    `).run(
      runId, submission.capturedAt ?? now, submission.keyAlias ?? null,
      submission.keyFingerprint ?? null, submission.apiGroup ?? null,
      submission.requestModel ?? null,
    );
    db.prepare(`
      INSERT INTO run_sources(run_id, source_type, first_seen_at, last_seen_at)
      VALUES(?, 'my_submission', ?, ?)
      ON CONFLICT(run_id, source_type) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(runId, now, now);
    db.prepare(`
      INSERT INTO run_enrichment_jobs(run_id, status, attempts, next_attempt_at, updated_at)
      VALUES(?, 'pending', 0, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = CASE WHEN run_enrichment_jobs.status = 'completed' THEN 'completed' ELSE 'pending' END,
        next_attempt_at = CASE WHEN run_enrichment_jobs.status = 'completed' THEN run_enrichment_jobs.next_attempt_at ELSE excluded.next_attempt_at END,
        updated_at = excluded.updated_at
    `).run(runId, now, now);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveAnnotation(db, runId, patch = {}, now = new Date().toISOString()) {
  const current = db.prepare("SELECT * FROM run_annotations WHERE run_id = ?").get(runId);
  const note = patch.note !== undefined ? patch.note : current?.note ?? null;
  const tags = patch.tags ? JSON.stringify([...new Set(patch.tags)]) : current?.custom_tags ?? "[]";
  const conclusion = patch.conclusion ?? current?.conclusion ?? "unset";
  const favorite = patch.isFavorite === undefined ? current?.is_favorite ?? 0 : patch.isFavorite ? 1 : 0;
  db.prepare(`
    INSERT INTO run_annotations(run_id, note, custom_tags, conclusion, is_favorite, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET note = excluded.note, custom_tags = excluded.custom_tags,
      conclusion = excluded.conclusion, is_favorite = excluded.is_favorite, updated_at = excluded.updated_at
  `).run(runId, note, tags, conclusion, favorite, now);
  return { runId, note, tags: JSON.parse(tags), conclusion, isFavorite: favorite === 1, updatedAt: now };
}

export function saveSiteAnnotation(db, host, patch = {}) {
  const site = db.prepare("SELECT host, note, is_favorite FROM sites WHERE host = ?").get(host);
  if (!site) return null;
  const note = patch.note !== undefined ? patch.note : site.note ?? null;
  const favorite = patch.isFavorite === undefined ? site.is_favorite ?? 0 : patch.isFavorite ? 1 : 0;
  db.prepare("UPDATE sites SET note = ?, is_favorite = ? WHERE host = ?").run(note, favorite, host);
  return { host, note, isFavorite: favorite === 1 };
}

export function saveRunDetails(db, item, now = new Date().toISOString()) {
  if (!item?.id && !item?.runId) return false;
  const normalized = { ...item, id: String(item.id || item.runId) };
  db.exec("SAVEPOINT run_details");
  try {
    savePublicObservation(db, normalized, now, { sourceType: null });
    db.exec("RELEASE run_details");
  } catch (error) {
    db.exec("ROLLBACK TO run_details");
    db.exec("RELEASE run_details");
    throw error;
  }
  db.prepare(`
    UPDATE run_enrichment_jobs
    SET status = 'completed', last_error = NULL, updated_at = ?
    WHERE run_id = ?
  `).run(now, normalized.id);
  return true;
}
