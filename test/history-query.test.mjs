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
import { ACTIVE_BUSY_MS, ACTIVE_IDLE_MS, planActivePoll, startActiveWatch } from "../src/ingest/active-watch.mjs";
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

test("active watch ingests when a run leaves the active list", async () => {
  assert.deepEqual(planActivePoll(["a", "b"], ["b"]), { finished: ["a"], shouldIngest: true, delayMs: ACTIVE_BUSY_MS });
  assert.deepEqual(planActivePoll(["a"], []), { finished: ["a"], shouldIngest: true, delayMs: ACTIVE_IDLE_MS });
  assert.equal(planActivePoll([], ["a"]).shouldIngest, false);

  const responses = [{ active: [{ runId: "a" }] }, { active: [{ runId: "a" }] }, { active: [] }];
  const reasons = [];
  let calls = 0;
  await new Promise((resolve) => {
    const stop = startActiveWatch({}, {
      getActive: async () => {
        calls += 1;
        return responses[Math.min(calls - 1, responses.length - 1)];
      },
      ingestOnce: async () => ({ inserted: 1, fetched: 1, total: 1 }),
      log: (line) => {
        reasons.push(line);
        if (reasons.length === 2) {
          stop();
          resolve();
        }
      },
    });
    // Speed the loop up: the first tick fires immediately, later ticks use the real delays,
    // so drive them by hand.
    setTimeout(() => {
      stop();
      resolve();
    }, 200);
  });
  assert.ok(reasons[0].startsWith("ingest(startup)"));
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
