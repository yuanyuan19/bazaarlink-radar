import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { savePublicObservation } from "../src/db/repository.mjs";
import { buildPlatform } from "../src/platform/server.mjs";
import { enrichPendingSubmissions } from "../src/core/submissions.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-radar-platform-"));
  const dbFile = path.join(dir, "test.sqlite");
  const db = new DatabaseSync(dbFile);
  migrateDb(db);
  savePublicObservation(db, {
    id: "public-1",
    baseUrl: "https://relay.example/v1",
    modelId: "anthropic/claude-opus-5",
    createdAt: "2026-09-02T10:00:00Z",
    identityConfirmed: true,
    score: 0.98,
  }, "2026-09-02T10:01:00Z");
  db.prepare("INSERT INTO my_submissions(run_id, captured_at, key_alias, api_group, request_model) VALUES(?,?,?,?,?)")
    .run("public-1", "2026-09-02T10:01:00Z", "测试 Key", "测试组", "anthropic/claude-opus-5");
  db.prepare("INSERT INTO run_sources(run_id, source_type, first_seen_at, last_seen_at) VALUES(?, 'my_submission', ?, ?)")
    .run("public-1", "2026-09-02T10:01:00Z", "2026-09-02T10:01:00Z");
  db.close();
  return { dir, dbFile };
}

test("platform exposes filtered history and annotations", async (t) => {
  const { dir, dbFile } = fixture();
  const app = buildPlatform({ db: dbFile });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().records, 1);

  const publicRuns = await app.inject({ method: "GET", url: "/api/public-runs?q=relay.example" });
  assert.equal(publicRuns.json().total, 1);
  assert.equal(publicRuns.json().rows[0].verdict, "match");

  const myRuns = await app.inject({ method: "GET", url: "/api/my-runs" });
  assert.equal(myRuns.json().total, 1);

  const annotation = await app.inject({
    method: "PATCH",
    url: "/api/runs/public-1/annotation",
    payload: { note: "稳定渠道", tags: ["收藏", "收藏"], conclusion: "trusted", isFavorite: true },
  });
  assert.equal(annotation.statusCode, 200);
  assert.deepEqual(annotation.json().tags, ["收藏"]);
  assert.equal(annotation.json().isFavorite, true);

  const invalid = await app.inject({
    method: "PATCH",
    url: "/api/runs/public-1/annotation",
    payload: { conclusion: "invalid" },
  });
  assert.equal(invalid.statusCode, 400);

  const site = await app.inject({ method: "GET", url: "/api/sites/relay.example" });
  assert.equal(site.statusCode, 200);
  assert.equal(site.json().models[0].sample_count, 1);

  const model = await app.inject({ method: "GET", url: "/api/models/anthropic%2Fclaude-opus-5" });
  assert.equal(model.statusCode, 200);
  assert.equal(model.json().sites[0].host, "relay.example");
});

test("internal submission intake is idempotent and enrichable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-radar-intake-"));
  const dbFile = path.join(dir, "test.sqlite");
  const app = buildPlatform({ db: dbFile });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const payload = {
    runId: "mine-1",
    baseUrl: "https://private-relay.example/v1",
    requestModel: "anthropic/claude-opus-5",
  };
  const secretRejected = await app.inject({
    method: "POST",
    url: "/internal/submissions",
    payload: { ...payload, apiKey: "sk-must-not-enter" },
  });
  assert.equal(secretRejected.statusCode, 400);
  for (let i = 0; i < 2; i++) {
    const accepted = await app.inject({
      method: "POST",
      url: "/internal/submissions",
      payload,
    });
    assert.equal(accepted.statusCode, 202);
  }
  const mine = await app.inject({ method: "GET", url: "/api/my-runs" });
  assert.equal(mine.json().total, 1);
  assert.equal(mine.json().rows[0].verdict, null);

  const db = new DatabaseSync(dbFile);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM my_submissions").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_enrichment_jobs").get().n, 1);
  const enriched = await enrichPendingSubmissions(db, {}, {
    fetchDetails: async () => ({
      id: "mine-1",
      baseUrl: payload.baseUrl,
      modelId: payload.requestModel,
      completedAt: "2026-09-03T03:30:00Z",
      identityConfirmed: true,
      score: 0.99,
    }),
    now: () => "2099-09-03T03:31:00Z",
  });
  assert.deepEqual(enriched, { attempted: 1, completed: 1, failed: 0 });
  assert.equal(db.prepare("SELECT status FROM run_enrichment_jobs WHERE run_id = 'mine-1'").get().status, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_sources WHERE run_id = 'mine-1' AND source_type = 'public_history'").get().n, 0);
  savePublicObservation(db, {
    id: "mine-1",
    baseUrl: payload.baseUrl,
    modelId: payload.requestModel,
    completedAt: "2026-09-03T03:30:00Z",
    identityConfirmed: true,
  }, "2026-09-03T03:32:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_sources WHERE run_id = 'mine-1'").get().n, 2);
  db.close();
});
