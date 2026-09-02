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

export function savePublicObservation(db, item, now) {
  if (!item?.id) return false;
  const siteId = siteFor(db, item, now);
  db.prepare(`
    INSERT INTO probe_runs(
      id, base_url, site_id, claimed_model_id, created_at,
      completed_at, source_report_url, raw_payload_ref, parser_version, ingested_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_url = COALESCE(excluded.base_url, probe_runs.base_url),
      site_id = COALESCE(excluded.site_id, probe_runs.site_id),
      claimed_model_id = COALESCE(excluded.claimed_model_id, probe_runs.claimed_model_id),
      completed_at = COALESCE(excluded.completed_at, probe_runs.completed_at)
  `).run(
    String(item.id), item.baseUrl ?? null, siteId, item.modelId ?? null, item.createdAt ?? null,
    item.completedAt ?? null, `https://bazaarlink.ai/probe?runId=${encodeURIComponent(item.id)}`, null, "history-v1", now,
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

  db.prepare(`
    INSERT INTO run_sources(run_id, source_type, first_seen_at, last_seen_at)
    VALUES(?, 'public_history', ?, ?)
    ON CONFLICT(run_id, source_type) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(String(item.id), now, now);
  return true;
}
