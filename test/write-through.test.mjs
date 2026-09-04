import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { saveMySubmission } from "../src/db/repository.mjs";
import { historyPage } from "../src/db/history-query.mjs";
import { hasRun, writeThroughCompleted } from "../src/mirror/write-through.mjs";

const UUID = "5a40ef87-ec24-451b-bf23-b0d4d3d5f6a9";
const CUID = "cmtllq9zr013x01pc8yr76g39";
const details = {
  id: CUID,
  runId: UUID,
  baseUrl: "https://mine.example/v1",
  modelId: "anthropic/claude-opus-5",
  createdAt: "2026-09-03T14:00:00Z",
  completedAt: "2026-09-03T14:09:45Z",
  identityConfirmed: true,
  score: 91,
  items: new Array(46).fill({}),
};

function openTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-wt-"));
  const db = new DatabaseSync(path.join(dir, "t.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  migrateDb(db);
  return db;
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test("completed run is written through before the list is read", async (t) => {
  const db = openTemp(t);
  saveMySubmission(db, { runId: UUID, baseUrl: details.baseUrl, requestModel: details.modelId }, "2026-09-03T14:00:00Z");
  const urls = [];
  const result = await writeThroughCompleted(db, "https://origin.example", UUID, {
    fetch: async (url) => {
      urls.push(url);
      return jsonResponse(details);
    },
    log: () => {},
  });
  assert.deepEqual(result, { written: true, id: CUID });
  assert.deepEqual(urls, [`https://origin.example/api/probe/history/${UUID}`]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 1);
  const row = db.prepare("SELECT id, run_uuid, is_public FROM probe_runs").get();
  assert.deepEqual([row.id, row.run_uuid, row.is_public], [CUID, UUID, 1]);
  const page = historyPage(db, {});
  assert.equal(page.history[0].id, CUID);
  assert.equal(page.history[0].score, 91);
  assert.equal(page.history[0].totalProbes, 46);
  assert.equal(hasRun(db, UUID), true);
  assert.equal(hasRun(db, CUID), true);
});

test("a run already in the database is not fetched again", async (t) => {
  const db = openTemp(t);
  await writeThroughCompleted(db, "https://origin.example", UUID, { fetch: async () => jsonResponse(details), log: () => {} });
  let calls = 0;
  const again = await writeThroughCompleted(db, "https://origin.example", CUID, {
    fetch: async () => {
      calls += 1;
      return jsonResponse(details);
    },
    log: () => {},
  });
  assert.deepEqual(again, { written: false, reason: "known" });
  assert.equal(calls, 0);
});

test("detail 404 or timeout leaves the database untouched and does not throw", async (t) => {
  const db = openTemp(t);
  const logs = [];
  const notFound = await writeThroughCompleted(db, "https://origin.example", UUID, {
    fetch: async () => jsonResponse({ error: "not found" }, 404),
    log: (l) => logs.push(l),
  });
  assert.equal(notFound.written, false);
  const slow = await writeThroughCompleted(db, "https://origin.example", UUID, {
    fetch: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    log: (l) => logs.push(l),
    timeoutMs: 20,
  });
  assert.equal(slow.written, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe_runs").get().n, 0);
  assert.ok(logs.some((l) => l.includes("HTTP 404")));
  assert.ok(logs.some((l) => l.includes("timeout")));
});
