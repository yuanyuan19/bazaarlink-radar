import { getJson, postJson } from "../api/client.mjs";
import { modeFlags } from "../util.mjs";

export function buildRunBody(input) {
  const modelId = input?.modelId || input?.model;
  if (!input?.baseUrl || !input?.apiKey || !modelId) {
    throw new Error("baseUrl, apiKey and model are required");
  }
  const body = {
    baseUrl: String(input.baseUrl),
    apiKey: String(input.apiKey),
    modelId: String(modelId),
    ...modeFlags(input.mode),
    lang: input.lang || "zh",
  };
  if (input.claimedModel || input.claimed) body.claimedModel = input.claimedModel || input.claimed;
  if (input.upstreamFormat || input.format) body.upstreamFormat = input.upstreamFormat || input.format;
  if (input.cfTurnstileToken) body.cfTurnstileToken = input.cfTurnstileToken;
  if (input.sync) body.sync = true;
  return body;
}

export async function startOfficialRun(input, flags = {}, dependencies = {}) {
  const post = dependencies.postJson || postJson;
  const body = buildRunBody(input);
  const started = await post(flags, "/api/probe/run", body, body.sync ? 180_000 : 30_000);
  const runId = started?.runId || started?.id;
  if (!runId) throw new Error("official probe did not return runId");
  return { started, runId, body };
}

export function displayScore(score) {
  if (score == null || score === "") return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export function liveProgress(run) {
  const items = Array.isArray(run?.items) ? run.items : [];
  const done = items.filter((item) =>
    item && (item.passed === true || item.passed === false || item.status === "completed" || item.completedAt || item.error),
  ).length;
  const total = Number(run?.totalProbes) || items.length || 0;
  return { done, total, percent: total ? Math.round((done / total) * 100) : null };
}

export async function fetchOfficialRun(runId, flags = {}, dependencies = {}) {
  const get = dependencies.getJson || getJson;
  return get(flags, `/api/probe/run/${encodeURIComponent(runId)}`);
}

export async function fetchOfficialDetails(runId, flags = {}, dependencies = {}) {
  const get = dependencies.getJson || getJson;
  return get(flags, `/api/probe/history/${encodeURIComponent(runId)}`);
}
