import crypto from "node:crypto";
import { getJson } from "../api/client.mjs";
import { saveMySubmission, saveRunDetails } from "../db/repository.mjs";

const MAX_TEXT = 500;

function optionalText(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, MAX_TEXT);
}

export function keyFingerprint(apiKey, secret) {
  if (!apiKey || !secret) return null;
  return crypto.createHmac("sha256", secret).update(String(apiKey)).digest("hex").slice(0, 24);
}

export function normalizeSubmission(input, { now = new Date().toISOString(), fingerprintSecret } = {}) {
  const runId = optionalText(input?.runId || input?.id);
  const baseUrl = optionalText(input?.baseUrl);
  const requestModel = optionalText(input?.requestModel || input?.modelId || input?.model);
  if (!runId || !baseUrl) throw new Error("runId and baseUrl are required");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  return {
    runId,
    baseUrl: parsed.toString(),
    requestModel,
    capturedAt: optionalText(input.capturedAt) || now,
    keyAlias: optionalText(input.keyAlias),
    apiGroup: optionalText(input.apiGroup),
    keyFingerprint: optionalText(input.keyFingerprint) || keyFingerprint(input.apiKey, fingerprintSecret),
  };
}

export function recordSubmission(db, input, options = {}) {
  const submission = normalizeSubmission(input, options);
  saveMySubmission(db, submission, options.now || submission.capturedAt);
  return submission;
}

export async function publishSubmission(input, options = {}) {
  const endpoint = String(options.endpoint || process.env.PLATFORM_INTERNAL_URL || "").replace(/\/$/, "");
  if (!endpoint) throw new Error("submission intake is not configured");
  const payload = normalizeSubmission(input, { now: options.now });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 2000));
      const response = await fetch(`${endpoint}/internal/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!response.ok) throw new Error(`submission intake returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function enrichPendingSubmissions(db, flags = {}, dependencies = {}) {
  const now = dependencies.now || (() => new Date().toISOString());
  const fetchDetails = dependencies.fetchDetails || ((runId) => getJson(flags, `/api/probe/history/${encodeURIComponent(runId)}`));
  const limit = Math.min(50, Math.max(1, Number(flags.limit || 10)));
  const dueAt = now();
  const jobs = db.prepare(`
    SELECT run_id, attempts FROM run_enrichment_jobs
    WHERE status != 'completed' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, run_id LIMIT ?
  `).all(dueAt, limit);
  const outcome = { attempted: jobs.length, completed: 0, failed: 0 };
  for (const job of jobs) {
    const startedAt = now();
    db.prepare(`
      UPDATE run_enrichment_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
      WHERE run_id = ?
    `).run(startedAt, job.run_id);
    try {
      const details = await fetchDetails(job.run_id);
      saveRunDetails(db, { ...details, id: details?.id || details?.runId || job.run_id }, now());
      outcome.completed += 1;
    } catch (error) {
      const attempts = Number(job.attempts) + 1;
      const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
      const failedAt = now();
      const nextAttemptAt = new Date(Date.parse(failedAt) + delayMs).toISOString();
      db.prepare(`
        UPDATE run_enrichment_jobs
        SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE run_id = ?
      `).run(nextAttemptAt, String(error?.message || error).slice(0, 1000), failedAt, job.run_id);
      outcome.failed += 1;
    }
  }
  return outcome;
}
