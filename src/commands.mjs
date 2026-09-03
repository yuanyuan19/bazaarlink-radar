import fs from "node:fs";
import path from "node:path";
import { getJson, postJson } from "./api/client.mjs";
import { loadVerdicts, pageVerdicts } from "./api/verdicts.mjs";
import { getPublicHistory, getRelayDirectory, getRelayHost } from "./core/public-data.mjs";
import {
  businessFailed,
  hostFromUrl,
  modeFlags,
  printJson,
  quantile,
  redactKey,
  stripKey,
  summarizeRun,
} from "./util.mjs";
import { ingestOnce } from "./ingest/history.mjs";
import { DatabaseSync } from "node:sqlite";
import { dbPathOf } from "./ingest/history.mjs";
import { migrateDb } from "./db/schema.mjs";
import { enrichPendingSubmissions, keyFingerprint, recordSubmission } from "./core/submissions.mjs";

const DISCLAIMER =
  "单次/聚合都不是长期保证。中转可以只对部分流量换模，也可以在检测时切回正货。相符只表示这次证据不支持偷换。";

function apiKeyOf(flags) {
  return flags.apiKey || process.env.BL_PROBE_API_KEY || process.env.PROBE_API_KEY || "";
}

function requireKey(flags) {
  const key = apiKeyOf(flags);
  if (!key) throw new Error("需要 --api-key 或环境变量 BL_PROBE_API_KEY");
  return key;
}

function writeOut(flags, data) {
  if (!flags.out) return;
  const file = path.resolve(String(flags.out));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stripKey(data), null, 2));
}

async function waitRun(flags, runId) {
  const interval = Number(flags.pollMs || 2000);
  const deadline = Date.now() + Number(flags.timeoutMs || 360_000);
  while (Date.now() < deadline) {
    const data = await getJson(flags, `/api/probe/run/${runId}`);
    const status = data.status;
    if (status === "completed" || status === "failed") return data;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`run ${runId} timed out`);
}

export async function cmdRun(flags) {
  if (!flags.baseUrl || !(flags.model || flags.modelId)) {
    throw new Error("run 需要 --base-url 和 --model");
  }
  const body = {
    baseUrl: flags.baseUrl,
    apiKey: requireKey(flags),
    modelId: flags.model || flags.modelId,
    ...modeFlags(flags.mode),
    sync: Boolean(flags.sync),
    lang: flags.lang || "zh",
  };
  if (flags.claimed) body.claimedModel = flags.claimed;
  if (flags.format) body.upstreamFormat = flags.format;
  if (flags.cfTurnstileToken) body.cfTurnstileToken = flags.cfTurnstileToken;

  const started = await postJson(flags, "/api/probe/run", body, body.sync ? 180_000 : 30_000);
  const runId = started.runId || started.id;
    if (runId) {
      const submission = {
        runId,
        baseUrl: body.baseUrl,
        requestModel: body.modelId,
        keyAlias: flags.keyAlias,
        apiGroup: flags.apiGroup,
        keyFingerprint: keyFingerprint(body.apiKey, flags.fingerprintSecret || process.env.KEY_FINGERPRINT_SECRET),
      };
      const db = new DatabaseSync(dbPathOf(flags));
      try {
        migrateDb(db);
        recordSubmission(db, submission);
      } finally {
        db.close();
      }
    }
  let result = started;
  if (flags.wait && !body.sync && runId) result = await waitRun(flags, runId);
  const summary = summarizeRun(result);
  writeOut(flags, result);
  printJson(
    {
      ok: result.status !== "failed",
      runId,
      status: result.status || summary.status,
      key: redactKey(body.apiKey),
      summary,
      raw: flags.raw ? stripKey(result) : undefined,
    },
    flags.pretty,
  );
  if (result.status === "failed") return 1;
  if (businessFailed(summary)) return 2;
  return 0;
}

export async function cmdStatus(flags, pos) {
  const runId = pos[0] || flags.runId;
  if (!runId) throw new Error("status 需要 runId");
  const data = await getJson(flags, `/api/probe/run/${runId}`);
  const summary = summarizeRun(data);
  printJson({ runId, status: data.status, summary, raw: flags.raw ? data : undefined }, flags.pretty);
  if (data.status === "failed") return 1;
  if (data.status === "completed" && businessFailed(summary)) return 2;
  return 0;
}

export async function cmdStop(flags, pos) {
  const runId = pos[0] || flags.runId;
  if (!runId) throw new Error("stop 需要 runId");
  const data = await postJson(flags, `/api/probe/run/${runId}/stop`, {});
  printJson(data, flags.pretty);
  return 0;
}

export async function cmdRetest(flags, pos) {
  const runId = pos[0] || flags.runId;
  if (!runId || !flags.probeId) throw new Error("retest 需要 runId 和 --probe-id");
  const data = await postJson(flags, `/api/probe/run/${runId}/retest`, { probeId: flags.probeId });
  printJson(data, flags.pretty);
  return 0;
}

export async function cmdHistory(flags, pos) {
  const id = pos[0];
  if (id) {
    const data = await getJson(flags, `/api/probe/history/${id}`);
    const summary = summarizeRun(data);
    printJson({ summary, raw: flags.raw ? data : data }, flags.pretty);
    return businessFailed(summary) ? 2 : 0;
  }
  const data = await getPublicHistory(flags, { limit: flags.limit || 50 });
  let rows = data.history;
  if (flags.host) {
    const h = String(flags.host).toLowerCase();
    rows = rows.filter((r) => hostFromUrl(r.baseUrl).toLowerCase().includes(h));
  }
  if (flags.model) {
    const m = String(flags.model).toLowerCase();
    rows = rows.filter((r) => String(r.modelId || "").toLowerCase().includes(m));
  }
  printJson(
    {
      truncated: data.truncated,
      count: rows.length,
      history: rows,
    },
    flags.pretty,
  );
  return 0;
}

async function loadDirectory(flags) {
  return getRelayDirectory(flags);
}

async function loadHostReport(flags, host) {
  return getRelayHost(flags, host);
}

export async function cmdRelays(flags) {
  const relays = await loadDirectory(flags);
  printJson({ count: relays.length, relays }, flags.pretty);
  return 0;
}

export async function cmdRelay(flags, pos) {
  const host = (pos[0] || flags.host || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host) throw new Error("relay 需要 host，例如 api.a6api.com");
  const report = await loadHostReport(flags, host);
  printJson(report, flags.pretty);
  return 0;
}

export async function cmdPulse(flags) {
  const [traffic, suggested, active, dir] = await Promise.all([
    getJson(flags, "/api/probe/traffic-24h"),
    getJson(flags, "/api/probe/suggested-models"),
    getJson(flags, "/api/probe/active").catch(() => ({ active: [] })),
    loadDirectory(flags),
  ]);
  const probeRuns = (traffic.buckets || []).reduce((s, b) => s + (b.probeRuns || 0), 0);
  const last = (traffic.buckets || [])[(traffic.buckets || []).length - 1] || null;
  printJson(
    {
      traffic24h: {
        probeRuns,
        last,
        buckets: traffic.buckets,
      },
      popular: dir.slice(0, 15),
      suggestedModels: (suggested.models || []).slice(0, 15),
      active: active.active || [],
    },
    flags.pretty,
  );
  return 0;
}

export async function cmdFraud(flags) {
  printJson(await getJson(flags, "/api/probe/fraud-list"), flags.pretty);
  return 0;
}

export async function cmdModels(flags) {
  if (flags.baseUrl) {
    const data = await postJson(flags, "/api/probe/models", {
      baseUrl: flags.baseUrl,
      apiKey: requireKey(flags),
    });
    printJson(data, flags.pretty);
    return 0;
  }
  printJson(await getJson(flags, "/api/probe/suggested-models"), flags.pretty);
  return 0;
}

export async function cmdBaselines(flags) {
  const query = flags.model ? { modelId: flags.model } : undefined;
  printJson(await getJson(flags, "/api/probe/baselines", query), flags.pretty);
  return 0;
}

export async function cmdEndpoints(flags) {
  const limit = Number(flags.limit || 50);
  const pages = Number(flags.pages || 1);
  let cursor = flags.cursor;
  const endpoints = [];
  let nextCursor = null;
  for (let i = 0; i < pages; i++) {
    const data = await getJson(flags, "/api/probe/endpoints", { limit, cursor });
    endpoints.push(...(data.endpoints || []));
    nextCursor = data.nextCursor || null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  printJson({ count: endpoints.length, nextCursor, endpoints }, flags.pretty);
  return 0;
}

export async function cmdPrices(flags) {
  const data = await getJson(flags, "/api/probe/model-prices");
  let models = data.models || [];
  if (flags.model) {
    const m = String(flags.model).toLowerCase();
    models = models.filter((x) => String(x.displayName || x.canonicalModelId || "").toLowerCase().includes(m));
  }
  printJson({ count: models.length, models }, flags.pretty);
  return 0;
}

export async function cmdActive(flags) {
  printJson(await getJson(flags, "/api/probe/active"), flags.pretty);
  return 0;
}

export async function cmdVerdicts(flags) {
  const all = await loadVerdicts(flags);
  const paged = pageVerdicts(all, {
    offset: flags.offset || 0,
    limit: flags.limit || 20,
    q: flags.q || flags.host || flags.model || "",
    verdict: flags.verdict || "",
  });
  printJson(paged, flags.pretty);
  return 0;
}

export async function cmdFleet(flags) {
  const id = flags.canonical || flags.model;
  if (!id) throw new Error("fleet 需要 --canonical 或 --model（如 claudeopus5）");
  printJson(await getJson(flags, "/api/probe/fleet-stats", { canonicalModelId: id }), flags.pretty);
  return 0;
}

function modelMatch(claimed, needle) {
  const n = String(needle || "").toLowerCase();
  if (!n) return true;
  const c = String(claimed || "").toLowerCase();
  if (n === "ops" || n === "opus") return c.includes("opus");
  return c.includes(n);
}

async function mapPool(items, concurrency, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return ret;
}

export async function cmdRank(flags) {
  const needle = flags.model || flags.q || "opus";
  const minRuns = Number(flags.minRuns || 15);
  const minDates = Number(flags.minDates || 5);
  const maxError = flags.maxErrorRate !== undefined ? Number(flags.maxErrorRate) : 1;
  const days = flags.days !== undefined ? Number(flags.days) : 7;
  const cutoff = Date.now() - days * 86400_000;

  const [dir, history, fraud] = await Promise.all([
    loadDirectory(flags),
    getJson(flags, "/api/probe/history", { limit: flags.historyLimit || 100 }),
    getJson(flags, "/api/probe/fraud-list").catch(() => ({ hosts: [] })),
  ]);

  const fraudSet = new Set((fraud.hosts || []).map((h) => h.host));
  let hosts = dir.filter((h) => h.runs >= minRuns && h.distinctDates >= minDates);
  hosts.sort((a, b) => b.runs - a.runs);
  if (!flags.all) {
    const cap = Number(flags.maxHosts || 80);
    hosts = hosts.slice(0, cap);
  }

  const reports = await mapPool(hosts, 6, async (h) => {
    try {
      return { ...h, ...(await loadHostReport(flags, h.host)) };
    } catch (err) {
      return { ...h, models: [], error: err.message };
    }
  });

  const histByHost = new Map();
  for (const row of history.history || []) {
    if (!modelMatch(row.modelId, needle)) continue;
    const host = hostFromUrl(row.baseUrl);
    const list = histByHost.get(host) || [];
    list.push(row);
    histByHost.set(host, list);
  }

  const order = { match: 0, family: 1, unknown: 2, substitution: 3 };
  const items = [];
  for (const rep of reports) {
    const matched = (rep.models || []).filter((m) => modelMatch(m.claimedModel, needle));
    if (!matched.length) continue;
    for (const m of matched) {
      if (m.lastProbe && Date.parse(m.lastProbe) < cutoff) continue;
      const hist = (histByHost.get(rep.host) || []).filter((r) => modelMatch(r.modelId, needle));
      const scores = hist.map((r) => r.score).filter((n) => typeof n === "number");
      const errN = hist.reduce((s, r) => s + (r.errorCount || 0), 0);
      const probeN = hist.reduce((s, r) => s + (r.totalProbes || 0), 0);
      const errorRate = probeN ? errN / probeN : null;
      if (errorRate !== null && errorRate > maxError) continue;
      if (flags.requireMatch && m.verdict !== "match") continue;
      items.push({
        host: rep.host,
        claimedModel: m.claimedModel,
        verdict: m.verdict,
        family: m.family,
        runs: m.runs,
        hostRuns: rep.runs,
        distinctDates: rep.distinctDates,
        lastAt: m.lastProbe,
        medianScore: quantile(scores, 0.5),
        errorRate,
        fraud: fraudSet.has(rep.host),
        sampleRunIds: hist.slice(0, 3).map((r) => r.id),
      });
    }
  }

  items.sort((a, b) => {
    const va = (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9);
    if (va) return va;
    const sa = (b.medianScore ?? -1) - (a.medianScore ?? -1);
    if (sa) return sa;
    return (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0);
  });

  printJson(
    {
      query: needle,
      scannedHosts: hosts.length,
      directorySize: dir.length,
      count: items.length,
      disclaimer: DISCLAIMER,
      items,
    },
    flags.pretty,
  );
  return 0;
}

export async function cmdServe(flags) {
  const { startMirror } = await import("./mirror/server.mjs");
  await startMirror(flags);
  await new Promise(() => {});
}

export async function cmdMaintenance(flags, pos) {
  const { runMaintenance } = await import("./maintenance/cli.mjs");
  printJson(runMaintenance(pos[0], flags), flags.pretty);
}

export async function cmdIngestHistory(flags) {
  printJson(await ingestOnce({ ...flags, reason: "cli" }), flags.pretty);
  return 0;
}

export async function cmdEnrichSubmissions(flags) {
  const db = new DatabaseSync(dbPathOf(flags));
  try {
    migrateDb(db);
    printJson(await enrichPendingSubmissions(db, flags), flags.pretty);
  } finally {
    db.close();
  }
  return 0;
}

export const COMMANDS = {
  run: cmdRun,
  status: cmdStatus,
  stop: cmdStop,
  retest: cmdRetest,
  history: cmdHistory,
  relays: cmdRelays,
  relay: cmdRelay,
  pulse: cmdPulse,
  fraud: cmdFraud,
  models: cmdModels,
  baselines: cmdBaselines,
  endpoints: cmdEndpoints,
  prices: cmdPrices,
  active: cmdActive,
  fleet: cmdFleet,
  verdicts: cmdVerdicts,
  rank: cmdRank,
  serve: cmdServe,
  maintenance: cmdMaintenance,
  "ingest-history": cmdIngestHistory,
  "enrich-submissions": cmdEnrichSubmissions,
};

export function usage() {
  return `用法: node src/cli.mjs <命令> [参数] [--pretty]

检测:
  run --base-url URL --api-key KEY --model ID [--mode quick|full|deep] [--wait] [--db PATH]
  status <runId>
  stop <runId>
  retest <runId> --probe-id ID

公开数据:
  history [--limit N] [--host HOST] [--model MODEL]
  history <runId>
  relays
  relay <host>
  pulse
  rank --model opus [--require-match] [--days 7] [--all]
  fraud
  models
  models --base-url URL --api-key KEY
  baselines [--model ID]
  endpoints [--limit N] [--pages N]
  prices [--model opus]
  fleet --canonical claudeopus5
  verdicts [--host a6api] [--verdict trusted] [--limit 20]
  active

镜像:
  serve [--port 8787] [--origin https://bazaarlink.ai] [--db PATH]

维护:
  maintenance migrate|cleanup|backup [--db PATH] [--pretty]

本地入库（检测纪录，按 id 去重；serve 进程内会自动采集，此处仅手动补拉）:
  ingest-history [--db PATH] [--pretty]
  enrich-submissions --db PATH [--limit 10]

Key 用 --api-key 或 BL_PROBE_API_KEY，不要写进仓库。`;
}
