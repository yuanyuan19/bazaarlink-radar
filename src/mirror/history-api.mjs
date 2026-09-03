import { historyPage } from "../db/history-query.mjs";
import { officialProbeCopy } from "../probe/probe-copy.mjs";

export function handleHistoryRoute(db, url) {
  if (url.pathname === "/__bl/history-page.json") {
    return historyPage(db, {
      q: url.searchParams.get("q") || "",
      band: url.searchParams.get("band") || "all",
      page: url.searchParams.get("page") || 1,
      limit: url.searchParams.get("limit") || 50,
      asOf: url.searchParams.get("asOf") || null,
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
