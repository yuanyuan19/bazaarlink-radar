import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { rekeyRun, saveMySubmission, savePublicObservation, saveRunDetails } from "../src/db/repository.mjs";
import { historyPage, latestIngestedAt } from "../src/db/history-query.mjs";
import { handleHistoryRoute } from "../src/mirror/history-api.mjs";
import { officialProbeCopy } from "../src/probe/probe-copy.mjs";

function openTemp(t, count, ingestedAt = "2026-09-02T00:00:00Z") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-history-"));
  const db = new DatabaseSync(path.join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  migrateDb(db);
  seed(db, 0, count, ingestedAt);
  return db;
}

function seed(db, from, to, ingestedAt) {
  for (let i = from; i < to; i++) {
    const minute = String(i % 60).padStart(2, "0");
    const hour = String(Math.floor(i / 60)).padStart(2, "0");
    savePublicObservation(db, {
      id: `c${String(i).padStart(24, "0")}`,
      baseUrl: `https://relay-${i}.example/v1`,
      modelId: "anthropic/claude-opus-5",
      createdAt: `2026-09-01T${hour}:${minute}:00Z`,
      identityConfirmed: true,
      score: (i * 7) % 100,
      identityOnly: i % 3 === 0,
      totalProbes: 46,
    }, ingestedAt);
  }
}

test("snapshot pages cover every row exactly once and newer rows only count", (t) => {
  const db = openTemp(t, 130);
  const first = historyPage(db, { limit: 50, page: 1 });
  assert.equal(first.total, 130);
  assert.equal(first.pages, 3);
  assert.equal(first.newerCount, 0);
  assert.equal(first.asOf, latestIngestedAt(db));

  // Records arriving after the anchor must not shift the pages the user is browsing.
  seed(db, 130, 145, "2026-09-03T00:00:00Z");
  const seen = new Set();
  for (let p = 1; p <= first.pages; p++) {
    const page = historyPage(db, { limit: 50, page: p, asOf: first.asOf });
    assert.equal(page.total, 130);
    assert.equal(page.newerCount, 15);
    for (const row of page.history) {
      assert.equal(seen.has(row.id), false, `duplicate ${row.id}`);
      seen.add(row.id);
    }
  }
  assert.equal(seen.size, 130);

  const fresh = historyPage(db, { limit: 50, page: 1 });
  assert.equal(fresh.total, 145);
  assert.equal(fresh.newerCount, 0);
  assert.equal(historyPage(db, { limit: 50, page: 99, asOf: first.asOf }).page, 3);
});

test("rows are shaped like the official history API with a 0-100 score", (t) => {
  const db = openTemp(t, 4);
  const [row] = historyPage(db, { limit: 1 }).history;
  assert.deepEqual(Object.keys(row).sort(), ["baseUrl", "confirmedMismatch", "createdAt", "errorCount", "id", "identityConfirmed", "identityOnly", "modelId", "mostSimilarDisplayName", "runId", "score", "totalProbes"].sort());
  assert.equal(row.score, 21);
  assert.equal(row.identityOnly, true);
  assert.equal(row.totalProbes, 46);
  savePublicObservation(db, { id: "legacy", baseUrl: "https://l.example/v1", modelId: "m", createdAt: "2026-09-01T09:00:00Z", score: 0.86 }, "2026-09-02T00:00:00Z");
  assert.equal(historyPage(db, { q: "l.example" }).history[0].score, 86);
});

test("the category column shows the official display name, never the prefixed model id", (t) => {
  const db = openTemp(t, 0);
  const at = "2026-09-04T03:00:00Z";
  // 列表项：官方直接给 mostSimilar*
  savePublicObservation(db, {
    id: "list1", baseUrl: "https://a.example/v1", modelId: "gpt-5.6-luna", createdAt: "2026-09-04T02:00:00Z", score: 88,
    identityConfirmed: true, v4ModelId: "openai/gpt-5.6-luna", v4DisplayName: "GPT 5.6 Luna", v4Abstained: false,
    mostSimilarModelId: "openai/gpt-5.6-luna", mostSimilarDisplayName: "GPT 5.6 Luna", mostSimilarFamily: "openai",
  }, at);
  // 列表项：v4 弃权 → 官方显示 ✓，不能回退到 v3f 的猜测
  savePublicObservation(db, {
    id: "list2", baseUrl: "https://b.example/v1", modelId: "anthropic/claude-sonnet-5", createdAt: "2026-09-04T01:00:00Z", score: 78,
    identityConfirmed: false, v3fModelId: "anthropic/claude-opus-4.7", v3fDisplayName: "Claude Opus 4.7",
    v4ModelId: null, v4DisplayName: null, v4Abstained: true, mostSimilarModelId: null, mostSimilarDisplayName: null,
  }, at);
  // 详情：识别结果只在 identityAssessment.v4.top
  saveRunDetails(db, {
    id: "det1", runId: "0feb52ad-2873-4d77-9996-1a901e4dc828", baseUrl: "https://c.example/v1", modelId: "gpt-5.6-terra",
    createdAt: "2026-09-04T00:00:00Z", completedAt: "2026-09-04T00:02:00Z", score: 90, identityConfirmed: true,
    identityAssessment: { v4: { abstained: false, top: { modelId: "openai/gpt-5.6-terra", displayName: "GPT 5.6 Terra", family: "openai" } } },
  }, at, { sourceType: "public_history" });
  const rows = historyPage(db, {}).history;
  assert.deepEqual(rows.map((r) => [r.id, r.mostSimilarDisplayName]), [["list1", "GPT 5.6 Luna"], ["list2", null], ["det1", "GPT 5.6 Terra"]]);
  assert.equal(db.prepare("SELECT actual_model FROM probe_results WHERE run_id = 'det1'").get().actual_model, "openai/gpt-5.6-terra");
});

test("q and band narrow the snapshot", (t) => {
  const db = openTemp(t, 20);
  assert.equal(historyPage(db, { q: "relay-7." }).total, 1);
  assert.equal(historyPage(db, { q: "CLAUDE" }).total, 20);
  for (const row of historyPage(db, { band: "80", limit: 200 }).history) assert.ok(row.score >= 80);
  for (const row of historyPage(db, { band: "low", limit: 200 }).history) assert.ok(row.score < 50);
  assert.equal(historyPage(db, { band: "running" }).total, 0);
});

test("handleHistoryRoute serves pages and copy", (t) => {
  const db = openTemp(t, 8);
  const page = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/history-page.json?limit=5&page=2"));
  assert.equal(page.page, 2);
  assert.equal(page.history.length, 3);
  const copy = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/probe-copy.json"));
  assert.equal(copy.history.histBand80, officialProbeCopy.history.histBand80);
  assert.equal(handleHistoryRoute(db, new URL("http://127.0.0.1/api/probe/history")), null);
});

test("a UUID submission is rekeyed onto the CUID once official details arrive", (t) => {
  const db = openTemp(t, 0);
  const uuid = "5a40ef87-ec24-451b-bf23-b0d4d3d5f6a9";
  const cuid = "cmtllq9zr013x01pc8yr76g39";
  saveMySubmission(db, { runId: uuid, baseUrl: "https://mine.example/v1", requestModel: "anthropic/claude-opus-5" }, "2026-09-03T14:00:00Z");
  saveRunDetails(db, { id: cuid, runId: uuid, baseUrl: "https://mine.example/v1", modelId: "anthropic/claude-opus-5", completedAt: "2026-09-03T14:09:45Z", identityConfirmed: true, score: 91 }, "2026-09-03T14:10:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 1);
  const row = db.prepare("SELECT id, run_uuid FROM probe_runs").get();
  assert.equal(row.id, cuid);
  assert.equal(row.run_uuid, uuid);
  assert.equal(db.prepare("SELECT run_id FROM my_submissions").get().run_id, cuid);
  savePublicObservation(db, { id: cuid, runId: uuid, baseUrl: "https://mine.example/v1", modelId: "anthropic/claude-opus-5", createdAt: "2026-09-03T14:00:00Z", score: 91 }, "2026-09-03T14:20:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 1);
  assert.equal(historyPage(db, {}).history[0].runId, uuid);
  assert.equal(rekeyRun(db, "missing", "other"), false);
});

test("inject scripts parse", () => {
  for (const name of ["history-virt.js", "perf.js", "pulse-virt.js"]) {
    new Function(fs.readFileSync(new URL(`../src/mirror/inject/${name}`, import.meta.url), "utf8"));
  }
});
