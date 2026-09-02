const DEFAULT_ORIGIN = "https://bazaarlink.ai";

export function originFrom(flags = {}) {
  return String(flags.origin || process.env.BL_PROBE_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");
}

export class ProbeError extends Error {
  constructor(message, { status, body, retryAfter } = {}) {
    super(message);
    this.name = "ProbeError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function request(flags, method, apiPath, { query, body, timeoutMs, headers } = {}) {
  const origin = originFrom(flags);
  const url = new URL(apiPath.startsWith("http") ? apiPath : origin + apiPath);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const maxRetry = 4;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs || 120_000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json, text/html;q=0.8, */*;q=0.1",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await res.text();
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      if (res.status === 429) {
        const wait = (retryAfter || 2 ** attempt) * 1000;
        lastErr = new ProbeError(`rate limited (429)`, { status: 429, body: text, retryAfter: wait });
        await sleep(wait);
        continue;
      }
      let parsed = text;
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const msg =
          parsed && typeof parsed === "object" && parsed.error
            ? String(parsed.error)
            : `HTTP ${res.status} ${method} ${url.pathname}`;
        throw new ProbeError(msg, { status: res.status, body: parsed });
      }
      return { status: res.status, headers: res.headers, data: parsed, text };
    } catch (err) {
      lastErr = err;
      if (err instanceof ProbeError && err.status && err.status < 500 && err.status !== 429) throw err;
      if (attempt === maxRetry) throw err;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function getJson(flags, apiPath, query) {
  const { data } = await request(flags, "GET", apiPath, { query });
  return data;
}

export async function postJson(flags, apiPath, body, timeoutMs) {
  const { data } = await request(flags, "POST", apiPath, { body, timeoutMs });
  return data;
}

export async function getText(flags, apiPath) {
  const { text } = await request(flags, "GET", apiPath, {
    headers: { accept: "text/html,application/json;q=0.8" },
  });
  return text;
}
