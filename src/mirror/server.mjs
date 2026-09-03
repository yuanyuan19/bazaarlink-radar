import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { originFrom } from "../api/client.mjs";
import { loadVerdicts, pageVerdicts, indexVerdicts, bootVerdicts } from "../api/verdicts.mjs";
import { dbPathOf, ingestOnce, openDb } from "../ingest/history.mjs";
import { enrichPendingSubmissions } from "../core/submissions.mjs";
import { handleHistoryRoute, jsonResponse } from "./history-api.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));

function readInject(name) {
  return fs.readFileSync(path.join(here, "inject", name), "utf8");
}

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

const getCache = new Map();
const CACHE_MS = 60_000;
// 检测记录列表是 history Tab 最需要新鲜度的接口，单独缩短缓存。
const HISTORY_CACHE_MS = 15_000;

function cacheTtl(urlPath) {
  return /^\/api\/probe\/history\/?$/.test(urlPath) ? HISTORY_CACHE_MS : CACHE_MS;
}

function cacheSet(key, entry) {
  const now = Date.now();
  for (const [k, v] of getCache) {
    if (now - v.at >= (v.ttl || CACHE_MS)) getCache.delete(k);
  }
  getCache.set(key, entry);
}

function redactLine(s) {
  return String(s || "").replace(/(api[_-]?key|authorization)["']?\s*[:=]\s*["']?[^"'\s,}&]+/gi, "$1=***");
}

function rewriteHtml(html, localOrigin) {
  let out = html
    .replaceAll("https://bazaarlink.ai", localOrigin)
    .replaceAll("http://bazaarlink.ai", localOrigin)
    .replaceAll("https://www.bazaarlink.ai", localOrigin)
    .replaceAll("https://api.bazaarlink.ai", localOrigin);
  const tags =
    `<script>window.__blPulseBootP=fetch("/__bl/pulse-boot.json").then(function(r){return r.json()});window.__blPulseIndexP=fetch("/__bl/pulse-index.json").then(function(r){return r.json()});window.__blHistBootP=fetch("/__bl/history-boot.json").then(function(r){return r.json()});</script>` +
    `<script src="/__bl/perf.js"></script><script src="/__bl/pulse-virt.js"></script><script src="/__bl/history-virt.js"></script>`;
  if (out.includes("</head>")) out = out.replace("</head>", `${tags}</head>`);
  else out = tags + out;
  return out;
}

function shouldCache(method, urlPath) {
  if (method !== "GET") return false;
  if (urlPath.startsWith("/api/probe/run")) return false;
  if (urlPath.startsWith("/api/probe/detect")) return false;
  if (urlPath.startsWith("/api/probe/models")) return false;
  return true;
}

function startBackgroundJobs(flags, dbFile) {
  let ingestBusy = false;
  let enrichBusy = false;

  const tickIngest = async () => {
    if (ingestBusy) return;
    ingestBusy = true;
    try {
      const result = await ingestOnce({ ...flags, db: dbFile, ifDue: true });
      if (!result.skipped && !result.reason) {
        process.stderr.write(`[mirror] ingest +${result.inserted}/${result.fetched} total=${result.total}\n`);
      }
    } catch (err) {
      process.stderr.write(`[mirror] ingest error: ${err.message}\n`);
    } finally {
      ingestBusy = false;
    }
  };

  const tickEnrich = async () => {
    if (enrichBusy) return;
    enrichBusy = true;
    const db = openDb(dbFile);
    try {
      const outcome = await enrichPendingSubmissions(db, flags, { limit: 5 });
      if (outcome.attempted) {
        process.stderr.write(`[mirror] enrich ${outcome.completed}/${outcome.attempted}\n`);
      }
    } catch (err) {
      process.stderr.write(`[mirror] enrich error: ${err.message}\n`);
    } finally {
      db.close();
      enrichBusy = false;
    }
  };

  tickIngest().catch(() => {});
  tickEnrich().catch(() => {});
  setInterval(() => {
    tickIngest().catch(() => {});
    tickEnrich().catch(() => {});
  }, 60_000);
}

export function createMirrorServer(flags = {}) {
  const origin = originFrom(flags);
  const port = Number(flags.port || 8787);
  const host = String(flags.host || process.env.MIRROR_HOST || "127.0.0.1");
  const noCache = Boolean(flags.noCache);
  const localOrigin = `http://127.0.0.1:${port}`;
  const dbFile = dbPathOf(flags);
  const db = openDb(dbFile);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", localOrigin);
      if (url.pathname === "/__bl/health") {
        const state = db.prepare("SELECT last_success_at, last_error FROM ingest_state WHERE id = 1").get();
        const count = db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n;
        const body = Buffer.from(JSON.stringify({
          status: "ok",
          service: "mirror",
          records: count,
          lastSuccessfulIngestAt: state?.last_success_at || null,
          lastError: state?.last_error || null,
        }), "utf8");
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(body.length),
        });
        res.end(body);
        return;
      }
      if (url.pathname === "/__bl/perf.js" || url.pathname === "/__bl/pulse-virt.js" || url.pathname === "/__bl/history-virt.js") {
        const name = url.pathname.slice("/__bl/".length);
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(readInject(name));
        return;
      }
      const historyPayload = handleHistoryRoute(db, url);
      if (historyPayload) {
        const out = jsonResponse(historyPayload);
        res.writeHead(out.status, out.headers);
        res.end(out.body);
        return;
      }
      if (url.pathname === "/__bl/pulse-boot.json" || url.pathname === "/__bl/pulse-index.json") {
        const all = await loadVerdicts({ origin, noCache: noCache || url.searchParams.has("fresh") });
        if (url.pathname.endsWith("pulse-boot.json")) {
          const payload = bootVerdicts(all, 48);
          const boot = Buffer.from(JSON.stringify(payload), "utf8");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=30",
            "content-length": String(boot.length),
          });
          res.end(boot);
          return;
        }
        const idx = indexVerdicts(all);
        const wantsGzip = /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
        const body = wantsGzip ? idx.gzip : idx.raw;
        const headers = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=30",
          "content-length": String(body.length),
        };
        if (wantsGzip) headers["content-encoding"] = "gzip";
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      if (url.pathname === "/api/probe/relay-verdicts") {
        const paged =
          url.searchParams.has("limit") ||
          url.searchParams.has("offset") ||
          url.searchParams.has("q") ||
          url.searchParams.has("host") ||
          url.searchParams.has("verdict") ||
          url.searchParams.has("exact") ||
          url.searchParams.get("mode") === "index";
        if (paged) {
          const all = await loadVerdicts({ origin, noCache: noCache || url.searchParams.has("fresh") });
          if (url.searchParams.get("mode") === "index") {
            const idx = indexVerdicts(all);
            const wantsGzip = /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
            const body = wantsGzip ? idx.gzip : idx.raw;
            const headers = {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "content-length": String(body.length),
            };
            if (wantsGzip) headers["content-encoding"] = "gzip";
            res.writeHead(200, headers);
            res.end(body);
            return;
          }
          const slice = pageVerdicts(all, {
            offset: url.searchParams.get("offset"),
            limit: url.searchParams.get("limit") || 24,
            q: url.searchParams.get("q") || url.searchParams.get("host") || "",
            verdict: url.searchParams.get("verdict") || "",
            exact: url.searchParams.get("exact") === "1",
          });
          const body = Buffer.from(JSON.stringify(slice), "utf8");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": String(body.length),
          });
          res.end(body);
          return;
        }
      }

      const cacheKey = req.method + " " + url.pathname + url.search;
      if (!noCache && shouldCache(req.method, url.pathname)) {
        const hit = getCache.get(cacheKey);
        if (hit && Date.now() - hit.at < (hit.ttl || CACHE_MS)) {
          res.writeHead(hit.status, hit.headers);
          res.end(hit.body);
          return;
        }
      }

      const chunks = [];
      for await (const c of req) chunks.push(c);
      const reqBody = Buffer.concat(chunks);
      if (/api[_-]?key/i.test(reqBody.toString("utf8"))) {
        process.stderr.write(`[mirror] ${req.method} ${url.pathname} (body has apiKey, not logged)\n`);
      } else {
        process.stderr.write(`[mirror] ${req.method} ${redactLine(url.pathname + url.search)}\n`);
      }

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!v) continue;
        if (HOP.has(k.toLowerCase())) continue;
        if (k.toLowerCase() === "host") continue;
        if (k.toLowerCase() === "accept-encoding") continue;
        headers[k] = v;
      }
      headers["accept-encoding"] = "identity";

      const upstream = await fetch(origin + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : reqBody,
        redirect: "manual",
      });

      const buf = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = {};
      upstream.headers.forEach((v, k) => {
        if (HOP.has(k.toLowerCase())) return;
        if (k.toLowerCase() === "content-security-policy") return;
        if (k.toLowerCase() === "content-security-policy-report-only") return;
        if (k.toLowerCase() === "strict-transport-security") return;
        if (k.toLowerCase() === "location") {
          outHeaders[k] = v.replaceAll(origin, localOrigin).replaceAll("https://bazaarlink.ai", localOrigin);
          return;
        }
        outHeaders[k] = v;
      });

      const ct = (upstream.headers.get("content-type") || "").toLowerCase();
      let body = buf;
      if (ct.includes("text/html")) {
        const html = rewriteHtml(buf.toString("utf8"), localOrigin);
        body = Buffer.from(html, "utf8");
        outHeaders["content-type"] = "text/html; charset=utf-8";
      }
      outHeaders["content-length"] = String(body.length);

      const cacheLimit = 24_000_000;
      if (!noCache && shouldCache(req.method, url.pathname) && upstream.status === 200 && body.length < cacheLimit) {
        cacheSet(cacheKey, { at: Date.now(), ttl: cacheTtl(url.pathname), status: upstream.status, headers: outHeaders, body });
      }

      res.writeHead(upstream.status, outHeaders);
      res.end(body);
    } catch (err) {
      process.stderr.write(`[mirror] error ${err.message}\n`);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("mirror proxy error: " + err.message);
    }
  });

  return { server, db, origin, port, host, noCache, localOrigin, dbFile };
}

export async function startMirror(flags) {
  const mirror = createMirrorServer(flags);
  const { server, db, origin, port, host, noCache, localOrigin, dbFile } = mirror;

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, resolve);
  });

  server.on("close", () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  const count = db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n;
  process.stderr.write(`镜像: ${localOrigin}/probe?tab=history  ←  ${origin}\n`);
  process.stderr.write(`SQLite ${dbFile}（${count} 条）；公开检测合并本地采集 + 虚拟滚动。?blperf=off 关掉注入\n`);
  startBackgroundJobs(flags, dbFile);

  loadVerdicts({ origin })
    .then((data) => {
      process.stderr.write(`[mirror] verdicts ${((data && data.cards) || []).length} cards\n`);
      return warmup(origin, localOrigin, noCache);
    })
    .then(
      (n) => {
        if (n) process.stderr.write(`[mirror] 预热 ${n} 项\n`);
      },
      (err) => process.stderr.write(`[mirror] 预热失败: ${err.message}\n`),
    );
}

async function warmup(origin, localOrigin, noCache) {
  if (noCache) return 0;
  const paths = ["/probe?tab=pulse", "/probe?tab=history"];
  let done = 0;
  for (const p of paths) {
    const key = "GET " + p;
    const hit = getCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      done += 1;
      continue;
    }
    try {
      const upstream = await fetch(origin + p, { headers: { "accept-encoding": "identity" } });
      if (!upstream.ok) continue;
      const ct = (upstream.headers.get("content-type") || "").toLowerCase();
      const raw = Buffer.from(await upstream.arrayBuffer());
      const body = ct.includes("text/html")
        ? Buffer.from(rewriteHtml(raw.toString("utf8"), localOrigin), "utf8")
        : raw;
      cacheSet(key, {
        at: Date.now(),
        status: 200,
        headers: {
          "content-type": ct.includes("text/html") ? "text/html; charset=utf-8" : ct || "application/json",
          "content-length": String(body.length),
        },
        body,
      });
      process.stderr.write(`[mirror] 预热 ${p} ${body.length}B\n`);
      done += 1;
    } catch (err) {
      process.stderr.write(`[mirror] 预热 ${p} 失败: ${err.message}\n`);
    }
  }
  return done;
}
