import { mergedHistoryPage } from "../db/history-query.mjs";
import { officialProbeCopy } from "../probe/probe-copy.mjs";

const OFFICIAL_TTL_MS = 15_000;
let officialCache = { at: 0, rows: [], promise: null };

export async function fetchOfficialWindow(origin, fetchImpl = fetch) {
  const now = Date.now();
  if (now - officialCache.at < OFFICIAL_TTL_MS) return officialCache.rows;
  if (officialCache.promise) return officialCache.promise;
  officialCache.promise = (async () => {
    try {
      const res = await fetchImpl(`${origin}/api/probe/history?limit=100`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      officialCache = { at: Date.now(), rows: Array.isArray(data?.history) ? data.history : [], promise: null };
    } catch (error) {
      process.stderr.write(`[mirror] official history window: ${error.message}\n`);
      officialCache = { ...officialCache, at: officialCache.rows.length ? Date.now() - OFFICIAL_TTL_MS + 3000 : 0, promise: null };
    }
    return officialCache.rows;
  })();
  return officialCache.promise;
}

export function seedOfficialWindow(rows) {
  officialCache = { at: Date.now(), rows: Array.isArray(rows) ? rows : [], promise: null };
}

export async function handleHistoryRoute(db, url, { origin, fetchImpl } = {}) {
  if (url.pathname === "/__bl/history-page.json") {
    const official = origin ? await fetchOfficialWindow(origin, fetchImpl) : [];
    return mergedHistoryPage(db, official, {
      q: url.searchParams.get("q") || "",
      band: url.searchParams.get("band") || "all",
      page: url.searchParams.get("page") || 1,
      limit: url.searchParams.get("limit") || 50,
    });
  }
  if (url.pathname === "/__bl/probe-copy.json") return officialProbeCopy;
  return null;
}

export function jsonResponse(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(body.length),
    },
    body,
  };
}
