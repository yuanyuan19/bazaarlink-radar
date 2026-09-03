import { bootPublicHistory, queryPublicHistory } from "../db/history-query.mjs";
import { officialProbeCopy } from "../probe/probe-copy.mjs";

export function handleHistoryRoute(db, url) {
  if (url.pathname === "/__bl/history-boot.json") {
    return bootPublicHistory(db, Number(url.searchParams.get("limit") || 48));
  }
  if (url.pathname === "/__bl/history.json" || url.pathname === "/__bl/history") {
    return queryPublicHistory(db, {
      q: url.searchParams.get("q") || "",
      band: url.searchParams.get("band") || "all",
      limit: url.searchParams.get("limit") || 50,
      after: url.searchParams.get("after") || null,
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
