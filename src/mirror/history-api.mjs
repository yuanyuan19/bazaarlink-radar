import { bootPublicHistory, queryPublicHistory } from "../db/history-query.mjs";
import { officialProbeCopy } from "../probe/probe-copy.mjs";

function parseExcludeIds(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function handleHistoryRoute(db, url) {
  const excludeIds = parseExcludeIds(url.searchParams.get("excludeIds"));
  if (url.pathname === "/__bl/history-boot.json") {
    const limit = Number(url.searchParams.get("limit") || 48);
    return bootPublicHistory(db, limit, excludeIds);
  }
  if (url.pathname === "/__bl/history.json" || url.pathname === "/__bl/history") {
    return queryPublicHistory(db, {
      q: url.searchParams.get("q") || "",
      band: url.searchParams.get("band") || "all",
      limit: Number(url.searchParams.get("limit") || 50),
      offset: Number(url.searchParams.get("offset") || 0),
      excludeIds,
    });
  }
  if (url.pathname === "/__bl/probe-copy.json") {
    return officialProbeCopy;
  }
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
