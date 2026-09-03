import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { rekeyRun, saveMySubmission, savePublicObservation, saveRunDetails } from "../src/db/repository.mjs";
import { bootPublicHistory, queryPublicHistory } from "../src/db/history-query.mjs";
import { handleHistoryRoute } from "../src/mirror/history-api.mjs";
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

test("cursor pagination covers every row exactly once", (t) => {
  const db = openTemp(t, 130);
  const seen = new Set();
  let after = null;
  let pages = 0;
  for (;;) {
    const page = queryPublicHistory(db, { limit: 50, after });
    pages += 1;
    for (const row of page.history) {
      assert.equal(seen.has(row.id), false, `duplicate ${row.id}`);
      seen.add(row.id);
    }
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
      break;
    }
    after = page.nextCursor;
  }
  assert.equal(pages, 3);
  assert.equal(seen.size, 130);
});

test("rows with equal created_at are ordered by id and never skipped", (t) => {
  const db = openTemp(t, 0);
  for (let i = 0; i < 7; i++) {
    savePublicObservation(db, { id: `same-${i}`, baseUrl: "https://x.example/v1", modelId: "m", createdAt: "2026-09-01T00:00:00Z", score: 0.9 }, "2026-09-02T00:00:00Z");
  }
  const first = queryPublicHistory(db, { limit: 3 });
  const second = queryPublicHistory(db, { limit: 3, after: first.nextCursor });
  const third = queryPublicHistory(db, { limit: 3, after: second.nextCursor });
  const ids = [...first.history, ...second.history, ...third.history].map((r) => r.id);
  assert.equal(new Set(ids).size, 7);
  assert.equal(third.hasMore, false);
});

test("q and band filters narrow the local history", (t) => {
  const db = openTemp(t, 20);
  const host = queryPublicHistory(db, { q: "relay-7.", limit: 10 });
  assert.equal(host.history.length, 1);
  assert.equal(host.history[0].id, `c${String(7).padStart(24, "0")}`);

  const high = queryPublicHistory(db, { band: "80", limit: 50 });
  assert.ok(high.history.length > 0);
  for (const row of high.history) assert.ok(row.displayScore >= 80);

  const low = queryPublicHistory(db, { band: "low", limit: 50 });
  for (const row of low.history) assert.ok(row.displayScore < 50);

  assert.equal(queryPublicHistory(db, { band: "running", limit: 50 }).history.length, 0);

  const boot = bootPublicHistory(db, 5);
  assert.equal(boot.history.length, 5);
  assert.equal(boot.hasMore, true);
});

test("handleHistoryRoute exposes boot, cursor pages and copy", (t) => {
  const db = openTemp(t, 8);
  const boot = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/history-boot.json?limit=3"));
  assert.equal(boot.history.length, 3);
  assert.ok(boot.nextCursor);

  const page = handleHistoryRoute(db, new URL(`http://127.0.0.1/__bl/history.json?limit=3&after=${encodeURIComponent(boot.nextCursor)}`));
  assert.equal(page.history.length, 3);
  assert.ok(!page.history.some((r) => boot.history.some((b) => b.id === r.id)));

  const copy = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/probe-copy.json"));
  assert.equal(copy.history.histBand80, officialProbeCopy.history.histBand80);
  assert.equal(handleHistoryRoute(db, new URL("http://127.0.0.1/api/probe/history")), null);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_sources WHERE run_id = ?").get(cuid).n, 1);

  // The public ingest later sees the same CUID: still one row, now with both sources.
  savePublicObservation(db, { id: cuid, runId: uuid, baseUrl: "https://mine.example/v1", modelId: "anthropic/claude-opus-5", createdAt: "2026-09-03T14:00:00Z", score: 0.91 }, "2026-09-03T14:20:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_sources WHERE run_id = ?").get(cuid).n, 2);

  const local = queryPublicHistory(db, { limit: 5 });
  assert.equal(local.history[0].runUuid, uuid);
  assert.equal(rekeyRun(db, "missing", "other"), false);
});

test("inject scripts parse", () => {
  for (const name of ["history-virt.js", "perf.js", "pulse-virt.js"]) {
    new Function(fs.readFileSync(new URL(`../src/mirror/inject/${name}`, import.meta.url), "utf8"));
  }
});
