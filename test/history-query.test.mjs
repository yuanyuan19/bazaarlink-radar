import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { rekeyRun, saveMySubmission, savePublicObservation, saveRunDetails } from "../src/db/repository.mjs";
import { countPublicHistory, matchesBand, matchesQuery, mergedHistoryPage, queryPublicHistory } from "../src/db/history-query.mjs";
import { handleHistoryRoute, seedOfficialWindow } from "../src/mirror/history-api.mjs";
import { officialProbeCopy } from "../src/probe/probe-copy.mjs";

function openTemp(t, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-history-"));
  const db = new DatabaseSync(path.join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  migrateDb(db);
  for (let i = 0; i < count; i++) {
    const minute = String(i % 60).padStart(2, "0");
    const hour = String(Math.floor(i / 60)).padStart(2, "0");
    savePublicObservation(db, {
      id: `c${String(i).padStart(24, "0")}`,
      baseUrl: `https://relay-${i}.example/v1`,
      modelId: "anthropic/claude-opus-5",
      createdAt: `2026-09-01T${hour}:${minute}:00Z`,
      identityConfirmed: true,
      score: ((i * 7) % 100) / 100,
    }, "2026-09-02T00:00:00Z");
  }
  return db;
}

function official(i) {
  return {
    id: `official-${i}`,
    baseUrl: `https://live-${i}.example/v1`,
    modelId: "openai/gpt-5.6-sol",
    score: 0.9,
    createdAt: `2026-09-05T00:${String(i).padStart(2, "0")}:00Z`,
    identityConfirmed: true,
    confirmedMismatch: false,
    errorCount: 0,
  };
}

test("merged pages cover official then local rows exactly once", (t) => {
  const db = openTemp(t, 130);
  const officialRows = Array.from({ length: 30 }, (_, i) => official(i));
  // Two official rows also exist locally under the same id: they must not be counted twice.
  savePublicObservation(db, { ...official(3) }, "2026-09-05T01:00:00Z");
  savePublicObservation(db, { ...official(4) }, "2026-09-05T01:00:00Z");

  const seen = new Set();
  const first = mergedHistoryPage(db, officialRows, { limit: 50, page: 1 });
  assert.equal(first.total, 160);
  assert.equal(first.pages, 4);
  assert.equal(first.officialCount, 30);
  assert.equal(first.history[0].id, "official-0");
  assert.equal(first.history[29].id, "official-29");
  assert.equal(first.history.length, 50);
  for (let p = 1; p <= first.pages; p++) {
    const page = mergedHistoryPage(db, officialRows, { limit: 50, page: p });
    for (const row of page.history) {
      assert.equal(seen.has(row.id), false, `duplicate ${row.id}`);
      seen.add(row.id);
    }
  }
  assert.equal(seen.size, 160);
  const clamped = mergedHistoryPage(db, officialRows, { limit: 50, page: 99 });
  assert.equal(clamped.page, 4);
  assert.equal(clamped.history.length, 10);
});

test("q and band apply to both official and local rows", (t) => {
  const db = openTemp(t, 20);
  const officialRows = [official(1), { ...official(2), score: 0.3 }];
  const byModel = mergedHistoryPage(db, officialRows, { q: "gpt-5.6", limit: 50 });
  assert.equal(byModel.total, 2);
  const byHost = mergedHistoryPage(db, officialRows, { q: "relay-7.", limit: 50 });
  assert.equal(byHost.total, 1);
  const high = mergedHistoryPage(db, officialRows, { band: "80", limit: 200 });
  assert.equal(high.history[0].id, "official-1");
  for (const row of high.history) assert.ok(Math.round(row.score * 100) >= 80);
  const low = mergedHistoryPage(db, officialRows, { band: "low", limit: 200 });
  assert.equal(low.history[0].id, "official-2");
  for (const row of low.history) assert.ok(Math.round(row.score * 100) < 50);
  const running = mergedHistoryPage(db, [{ ...official(9), score: null, totalProbes: 98, doneProbes: 3 }], { band: "running" });
  assert.equal(running.total, 1);
  assert.equal(running.localCount, 0);
  assert.equal(matchesQuery(official(1), "LIVE-1"), true);
  assert.equal(matchesBand({ score: null, totalProbes: 98 }, "80"), false);
  assert.equal(countPublicHistory(db, { q: "nomatch" }), 0);
  assert.equal(queryPublicHistory(db, { limit: 3 }).length, 3);
});

test("local rows are shaped like the official history API", (t) => {
  const db = openTemp(t, 1);
  const [row] = queryPublicHistory(db, { limit: 1 });
  assert.deepEqual(Object.keys(row).sort(), ["baseUrl", "confirmedMismatch", "createdAt", "errorCount", "id", "identityConfirmed", "modelId", "mostSimilarDisplayName", "runId", "score"].sort());
  assert.equal(row.runId, undefined);
  assert.equal(row.score, 0);
});

test("handleHistoryRoute serves merged pages using the cached official window", async (t) => {
  const db = openTemp(t, 8);
  seedOfficialWindow([official(1), official(2)]);
  const page = await handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/history-page.json?limit=5&page=1"), { origin: "https://unused.example" });
  assert.equal(page.total, 10);
  assert.equal(page.pages, 2);
  assert.equal(page.history.length, 5);
  assert.equal(page.history[0].id, "official-0".replace("0", "1"));
  const copy = await handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/probe-copy.json"));
  assert.equal(copy.history.histBand80, officialProbeCopy.history.histBand80);
  assert.equal(await handleHistoryRoute(db, new URL("http://127.0.0.1/api/probe/history")), null);
});

test("a UUID submission is rekeyed onto the CUID once official details arrive", (t) => {
  const db = openTemp(t, 0);
  const uuid = "5a40ef87-ec24-451b-bf23-b0d4d3d5f6a9";
  const cuid = "cmtllq9zr013x01pc8yr76g39";
  saveMySubmission(db, { runId: uuid, baseUrl: "https://mine.example/v1", requestModel: "anthropic/claude-opus-5" }, "2026-09-03T14:00:00Z");
  assert.equal(db.prepare("SELECT run_uuid FROM probe_runs WHERE id = ?").get(uuid).run_uuid, uuid);

  saveRunDetails(db, { id: cuid, runId: uuid, baseUrl: "https://mine.example/v1", modelId: "anthropic/claude-opus-5", completedAt: "2026-09-03T14:09:45Z", identityConfirmed: true, score: 0.91 }, "2026-09-03T14:10:00Z");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 1);
  const row = db.prepare("SELECT id, run_uuid FROM probe_runs").get();
  assert.equal(row.id, cuid);
  assert.equal(row.run_uuid, uuid);
  assert.equal(db.prepare("SELECT run_id FROM my_submissions").get().run_id, cuid);
  assert.equal(db.prepare("SELECT status FROM run_enrichment_jobs WHERE run_id = ?").get(cuid).status, "completed");

  savePublicObservation(db, { id: cuid, runId: uuid, baseUrl: "https://mine.example/v1", modelId: "anthropic/claude-opus-5", createdAt: "2026-09-03T14:00:00Z", score: 0.91 }, "2026-09-03T14:20:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_sources WHERE run_id = ?").get(cuid).n, 2);

  // The official window may reference the run by UUID: it must still be excluded from the local tail.
  const merged = mergedHistoryPage(db, [{ id: uuid, baseUrl: "https://mine.example/v1", modelId: "anthropic/claude-opus-5", score: 0.91, createdAt: "2026-09-03T14:00:00Z" }], { limit: 10 });
  assert.equal(merged.total, 1);
  assert.equal(rekeyRun(db, "missing", "other"), false);
});

test("inject scripts parse", () => {
  for (const name of ["history-virt.js", "perf.js", "pulse-virt.js"]) {
    new Function(fs.readFileSync(new URL(`../src/mirror/inject/${name}`, import.meta.url), "utf8"));
  }
});
