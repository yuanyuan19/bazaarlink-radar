import zlib from "node:zlib";
import { request } from "./client.mjs";
import { readCache, writeCache } from "../util.mjs";

const CACHE_REL = "relay-verdicts.json";
const CACHE_MS = 60_000;
const PAGE = 24;

let mem = null;
let indexCache = null;
let refreshing = null;

function slimCard(card) {
  return {
    ...card,
    heatmap: Array.isArray(card.heatmap) ? card.heatmap.slice(-24) : card.heatmap,
    models: Array.isArray(card.models)
      ? card.models.map((m) => ({ ...m, runs: [] }))
      : card.models,
  };
}

function downsampleAvailability(av) {
  if (!Array.isArray(av) || av.length === 0) return [];
  const step = av.length > 36 ? Math.ceil(av.length / 36) : 1;
  const out = [];
  for (let i = 0; i < av.length && out.length < 36; i += step) {
    out.push({ s: av[i].s });
  }
  return out;
}

export function compactCard(card) {
  const heatmap = Array.isArray(card.heatmap)
    ? card.heatmap
        .filter((r) => Array.isArray(r.cells) && r.cells.some((c) => c.kind && c.kind !== "empty"))
        .slice(0, 12)
        .map((r) => ({
          claimedModelId: r.claimedModelId,
          cells: (r.cells || []).map((c) => ({
            kind: c.kind,
            coverageWarning: !!c.coverageWarning,
          })),
        }))
    : [];
  return {
    host: card.host,
    baseUrl: card.baseUrl,
    verdict: card.verdict,
    health: card.health,
    passRate: card.passRate,
    claimedModelCount: card.claimedModelCount,
    bestScore: card.bestScore,
    avgLatencyMs: card.avgLatencyMs,
    lastProbedAt: card.lastProbedAt,
    firstSeenAt: card.firstSeenAt,
    uptimePct: card.uptimePct,
    staleProbeCount: card.staleProbeCount,
    availability: downsampleAvailability(card.availability),
    heatmap,
    models: Array.isArray(card.models)
      ? card.models.map((m) => ({ claimedModelId: m.claimedModelId }))
      : [],
  };
}

function saveVerdicts(data) {
  mem = { at: Date.now(), data };
  indexCache = null;
  try {
    writeCache(CACHE_REL, JSON.stringify(data));
  } catch {
    /* ignore disk */
  }
  return data;
}

function refreshVerdicts(flags) {
  if (refreshing) return refreshing;
  refreshing = request(flags, "GET", "/api/probe/relay-verdicts", { timeoutMs: 180_000 })
    .then(({ data }) => {
      saveVerdicts(data);
      indexVerdicts(data);
      return data;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function loadVerdicts(flags = {}) {
  if (flags.noCache) {
    const { data } = await request(flags, "GET", "/api/probe/relay-verdicts", { timeoutMs: 180_000 });
    return saveVerdicts(data);
  }
  if (mem) {
    if (Date.now() - mem.at >= CACHE_MS) refreshVerdicts(flags).catch(() => {});
    return mem.data;
  }
  const cached = readCache(CACHE_REL, 24 * 60 * 60 * 1000, false);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      mem = { at: Date.now(), data };
      refreshVerdicts(flags).catch(() => {});
      return data;
    } catch {
      /* fall through */
    }
  }
  const { data } = await request(flags, "GET", "/api/probe/relay-verdicts", { timeoutMs: 180_000 });
  return saveVerdicts(data);
}

function matchQuery(card, needle) {
  if (!needle) return true;
  if (String(card.host || "").toLowerCase().includes(needle)) return true;
  if (String(card.baseUrl || "").toLowerCase().includes(needle)) return true;
  const models = card.models || [];
  for (let i = 0; i < models.length; i++) {
    if (String(models[i].claimedModelId || "").toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function pageVerdicts(data, opts = {}) {
  const needle = String(opts.q || "").toLowerCase();
  const v = String(opts.verdict || "").toLowerCase();
  const exact = Boolean(opts.exact);
  let cards = data.cards || [];
  if (needle) {
    cards = exact
      ? cards.filter(
          (c) =>
            String(c.host || "").toLowerCase() === needle ||
            String(c.baseUrl || "").toLowerCase() === needle,
        )
      : cards.filter((c) => matchQuery(c, needle));
  }
  if (v) cards = cards.filter((c) => String(c.verdict || "").toLowerCase() === v);
  const start = Math.max(0, Number(opts.offset) || 0);
  const take = Math.max(1, Math.min(200, Number(opts.limit) || PAGE));
  return {
    summary: data.summary || null,
    cards: cards.slice(start, start + take).map(slimCard),
    totalCards: cards.length,
    offset: start,
    limit: take,
    truncated: start + take < cards.length,
  };
}

export function indexVerdicts(data) {
  if (indexCache && mem && indexCache.at === mem.at) return indexCache;
  const payload = {
    summary: data.summary || null,
    cards: (data.cards || []).map(compactCard),
    totalCards: (data.cards || []).length,
  };
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const gzip = zlib.gzipSync(raw, { level: 6 });
  indexCache = { at: mem ? mem.at : Date.now(), raw, gzip, payload };
  return indexCache;
}

export function bootVerdicts(data, limit = 48) {
  const idx = indexVerdicts(data);
  return {
    summary: idx.payload.summary,
    cards: idx.payload.cards.slice(0, limit),
    totalCards: idx.payload.totalCards,
    boot: true,
  };
}

export function peekIndex() {
  return indexCache;
}

export function defaultPageSize() {
  return PAGE;
}
