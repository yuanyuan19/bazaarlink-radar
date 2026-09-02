import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const cmd = argv[0] || "";
  const flags = {};
  const pos = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pretty") flags.pretty = true;
    else if (a === "--wait") flags.wait = true;
    else if (a === "--require-match") flags.requireMatch = true;
    else if (a === "--no-cache") flags.noCache = true;
    else if (a === "--all") flags.all = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else pos.push(a);
  }
  return { cmd, flags, pos };
}

export function printJson(data, pretty) {
  process.stdout.write((pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + "\n");
}

export function redactKey(key) {
  if (!key || typeof key !== "string") return key;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

export function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "")
      .replace(/^https?:\/\//, "")
      .split("/")[0];
  }
}

export function quantile(nums, q) {
  const a = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] * (hi - i) + a[hi] * (i - lo);
}

export function cachePath(rel) {
  const root = path.resolve(here, "..", "data", "cache");
  return path.join(root, rel);
}

export function readCache(rel, maxAgeMs, noCache) {
  if (noCache) return null;
  const file = cachePath(rel);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > maxAgeMs) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function writeCache(rel, text) {
  const file = cachePath(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function stripKey(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/api[_-]?key/i.test(k)) out[k] = redactKey(String(v || ""));
    else if (v && typeof v === "object") out[k] = stripKey(v);
    else out[k] = v;
  }
  return out;
}

export function modeFlags(mode) {
  const m = String(mode || "quick").toLowerCase();
  if (m === "full") return { quickMode: false, identityOnly: false, runContextCheck: false };
  if (m === "deep") return { quickMode: false, identityOnly: false, runContextCheck: true };
  return { quickMode: true, identityOnly: true, runContextCheck: false };
}

export function summarizeRun(run) {
  const ident = run.identityAssessment || {};
  const items = Array.isArray(run.items) ? run.items : [];
  const ttfts = items.map((i) => i.ttftMs);
  const tps = items.map((i) => i.tps);
  const leak = items.find((i) => i.probeId === "identity_leak");
  const inflation = items.find((i) => i.probeId === "token_inflation");
  const fails = (g) =>
    items.filter((i) => i.group === g && i.passed === false).map((i) => i.probeId);
  return {
    runId: run.runId || run.id,
    status: run.status || (run.completedAt ? "completed" : undefined),
    score: run.score ?? null,
    modelId: run.modelId,
    baseUrl: run.baseUrl,
    host: hostFromUrl(run.baseUrl),
    identity: {
      status: ident.status ?? null,
      verdict: ident.verdict?.status ?? null,
      claimedModel: ident.claimedModel || run.modelId || null,
      predictedFamily: ident.predictedFamily || run.predictedFamily || null,
      v3fModelId: ident.v3f?.top?.modelId || ident.subModelMatchV3F?.modelId || run.v3fModelId || null,
      v4ModelId: ident.v4?.top?.modelId || run.v4ModelId || null,
      identityConfirmed: run.identityConfirmed ?? null,
      confirmedMismatch: run.confirmedMismatch ?? null,
      riskFlags: ident.riskFlags || [],
    },
    leak: leak ? { passed: leak.passed, status: leak.status, probeId: leak.probeId } : null,
    tokenInflation: inflation
      ? { passed: inflation.passed, status: inflation.status, detail: inflation.tokenInflation || null }
      : null,
    performance: {
      ttftMs: { p50: quantile(ttfts, 0.5), p95: quantile(ttfts, 0.95) },
      tps: { p50: quantile(tps, 0.5), p95: quantile(tps, 0.95) },
    },
    securityFails: fails("security"),
    integrityFails: fails("integrity"),
    tokens: { input: run.totalInputTokens ?? null, output: run.totalOutputTokens ?? null },
    errorCount: run.errorCount ?? items.filter((i) => i.error).length,
    totalProbes: run.totalProbes ?? items.length,
  };
}

export function businessFailed(summary) {
  const ident = summary.identity || {};
  if (ident.status === "mismatch" || ident.confirmedMismatch === true) return true;
  if (summary.leak && summary.leak.passed === false) return true;
  if (summary.tokenInflation && summary.tokenInflation.passed === false) return true;
  return false;
}
