export function parseRelayDirectory(html) {
  const re =
    /href="\/(?:en\/)?probe\/relay\/([^"]+)"[^>]*>([^<]+)<\/a><\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td>/g;
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(re)) {
    const host = m[1];
    if (seen.has(host)) continue;
    if (host.endsWith(".js")) continue;
    seen.add(host);
    out.push({
      host,
      runs: Number(String(m[3]).replace(/[^\d]/g, "")) || 0,
      distinctDates: Number(String(m[4]).replace(/[^\d]/g, "")) || 0,
      modelCount: Number(String(m[5]).replace(/[^\d]/g, "")) || 0,
    });
  }
  return out;
}

const VERDICT = [
  [/家族相符|family match/i, "family"],
  [/相符|^match$/i, "match"],
  [/替換|substitution/i, "substitution"],
  [/未確定|unknown/i, "unknown"],
];

export function normalizeVerdict(text) {
  const s = String(text || "").trim();
  for (const [re, v] of VERDICT) {
    if (re.test(s)) return v;
  }
  return s ? "unknown" : null;
}

export function parseRelayHost(html, host) {
  const models = [];
  const rowRe =
    /<tr[^>]*>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<\/tr>/gi;
  for (const m of html.matchAll(rowRe)) {
    const claimedModel = m[1].trim();
    const verdictRaw = m[2].trim();
    if (/宣稱模型|claimed model/i.test(claimedModel)) continue;
    if (/指紋判定|fingerprint/i.test(verdictRaw)) continue;
    const verdict = normalizeVerdict(verdictRaw);
    if (!verdict) continue;
    models.push({
      claimedModel,
      verdict,
      verdictRaw,
      family: m[3].trim().replace(/^—$/, "") || null,
      runs: Number(String(m[4]).replace(/[^\d]/g, "")) || 0,
      lastProbe: m[5].trim() || null,
    });
  }
  const runs = models.reduce((s, r) => s + r.runs, 0);
  return { host, models, runs, modelCount: models.length };
}
