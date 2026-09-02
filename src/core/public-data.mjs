import { getJson, getText } from "../api/client.mjs";
import { parseRelayDirectory, parseRelayHost } from "../api/parse-relay.mjs";
import { hostFromUrl, readCache, writeCache } from "../util.mjs";

export const PUBLIC_HISTORY_LIMIT = 100;
export const PUBLIC_CACHE_TTL_MS = 30 * 60_000;

export async function getPublicHistory(flags = {}, { limit = PUBLIC_HISTORY_LIMIT } = {}) {
  const data = await getJson(flags, "/api/probe/history", { limit });
  return {
    truncated: Boolean(data?.truncated),
    history: Array.isArray(data?.history) ? data.history : [],
  };
}

export async function getRelayDirectory(flags = {}) {
  const cached = readCache("relay-dir.html", PUBLIC_CACHE_TTL_MS, flags.noCache);
  const html = cached || (await getText(flags, "/probe/relay"));
  if (!cached) writeCache("relay-dir.html", html);
  return parseRelayDirectory(html);
}

export async function getRelayHost(flags = {}, host) {
  const normalized = hostFromUrl(host).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!normalized) throw new Error("host is required");
  const rel = `relay-host/${normalized.replace(/[^\w.-]/g, "_")}.html`;
  const cached = readCache(rel, PUBLIC_CACHE_TTL_MS, flags.noCache);
  const html = cached || (await getText(flags, `/probe/relay/${normalized}`));
  if (!cached) writeCache(rel, html);
  return parseRelayHost(html, normalized);
}
