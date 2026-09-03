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
import { modelIdsFrom, officialProbeCopy } from "../src/platform/probe-copy.mjs";

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

  const sites = await app.inject({ method: "GET", url: "/api/sites?sort=run_count" });
  assert.equal(sites.statusCode, 200);
  assert.equal(sites.json().rows[0].host, "relay.example");
  assert.equal(sites.json().rows[0].match_count, 1);

  const site = await app.inject({ method: "GET", url: "/api/sites/relay.example" });
  assert.equal(site.statusCode, 200);
  assert.equal(site.json().models[0].sample_count, 1);

  const model = await app.inject({ method: "GET", url: "/api/models/anthropic%2Fclaude-opus-5" });
  assert.equal(model.statusCode, 200);
  assert.equal(model.json().sites[0].host, "relay.example");
});

test("my-runs submit never persists the api key", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-radar-submit-"));
  const dbFile = path.join(dir, "test.sqlite");
  const app = buildPlatform({ db: dbFile }, {
    startOfficialRun: async (input) => {
      assert.equal(input.apiKey, "sk-must-not-persist");
      return {
        started: { status: "queued" },
        runId: "mine-ui-1",
        body: { baseUrl: input.baseUrl, modelId: input.modelId },
      };
    },
    fetchOfficialRun: async () => ({ id: "mine-ui-1", status: "running", items: [{ passed: true }, { status: "running" }], totalProbes: 10 }),
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rejected = await app.inject({
    method: "POST",
    url: "/api/my-runs",
    payload: { baseUrl: "file:///tmp/key", apiKey: "sk-must-not-persist", modelId: "anthropic/claude-opus-5" },
  });
  assert.equal(rejected.statusCode, 400);

  const created = await app.inject({
    method: "POST",
    url: "/api/my-runs",
    payload: {
      baseUrl: "https://private-relay.example/v1",
      apiKey: "sk-must-not-persist",
      modelId: "anthropic/claude-opus-5",
    },
  });
  assert.equal(created.statusCode, 202);
  assert.equal(created.json().runId, "mine-ui-1");

  const mine = await app.inject({ method: "GET", url: "/api/my-runs?q=private-relay" });
  assert.equal(mine.json().total, 1);
  assert.equal(mine.json().rows[0].pending, true);
  assert.equal(mine.json().rows[0].note, null);

  const live = await app.inject({ method: "GET", url: "/api/runs/mine-ui-1/live" });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().status, "running");
  assert.equal(live.json().progress.done, 1);

  const db = new DatabaseSync(dbFile);
  const dumped = JSON.stringify(db.prepare("SELECT * FROM my_submissions").all());
  assert.equal(dumped.includes("sk-must-not-persist"), false);
  db.close();
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

test("sites can be favorited and annotated, and models are fetched not hardcoded", async (t) => {
  const { dir, dbFile } = fixture();
  const app = buildPlatform({ db: dbFile }, {
    postJson: async (_flags, apiPath, body) => {
      assert.equal(apiPath, "/api/probe/models");
      assert.equal(body.apiKey, "sk-forward-only");
      return { models: ["anthropic/claude-opus-5", { modelId: "openai/gpt-5.6-sol" }] };
    },
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const copy = await app.inject({ method: "GET", url: "/api/probe-copy" });
  assert.equal(copy.statusCode, 200);
  assert.equal(copy.json().history.histQuickModeNote, officialProbeCopy.history.histQuickModeNote);
  assert.equal(copy.json().modes[0].id, "quick");

  const endpoint = await app.inject({
    method: "POST",
    url: "/api/endpoint-models",
    payload: { baseUrl: "https://relay.example/v1", apiKey: "sk-forward-only" },
  });
  assert.equal(endpoint.statusCode, 200);
  assert.deepEqual(endpoint.json().models, ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"]);

  const saved = await app.inject({
    method: "PATCH",
    url: "/api/sites/relay.example",
    payload: { note: "这站比较稳", isFavorite: true },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().isFavorite, true);
  assert.equal(saved.json().note, "这站比较稳");

  const publicRuns = await app.inject({ method: "GET", url: "/api/public-runs?favorite=1" });
  assert.equal(publicRuns.json().total, 1);
  assert.equal(publicRuns.json().rows[0].isFavorite, true);
  assert.equal(publicRuns.json().rows[0].note, "这站比较稳");

  const searched = await app.inject({ method: "GET", url: "/api/public-runs?q=比较稳" });
  assert.equal(searched.json().total, 1);

  const sites = await app.inject({ method: "GET", url: "/api/sites?favorite=1" });
  assert.equal(sites.json().total, 1);
  assert.equal(sites.json().rows[0].isFavorite, true);
  assert.equal(sites.json().rows[0].weekRate, 100);
});

test("run and site filters combine as AND fields", async (t) => {
  const { dir, dbFile } = fixture();
  const app = buildPlatform({ db: dbFile });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const filters = await app.inject({ method: "GET", url: "/api/filters" });
  assert.equal(filters.statusCode, 200);
  assert.equal(filters.json().models[0].id, "anthropic/claude-opus-5");

  const byModel = await app.inject({ method: "GET", url: "/api/public-runs?model=anthropic/claude-opus-5&verdict=match&scoreMin=80" });
  assert.equal(byModel.json().total, 1);

  const miss = await app.inject({ method: "GET", url: "/api/public-runs?verdict=substitution" });
  assert.equal(miss.json().total, 0);

  const site = await app.inject({ method: "GET", url: "/api/sites/relay.example" });
  assert.equal(site.json().overview.total_count, 1);
  assert.equal(site.json().overview.week_rate, 100);

  const pendingIgnored = await app.inject({ method: "GET", url: "/api/public-runs?pending=1" });
  assert.equal(pendingIgnored.json().total, 1);
  assert.equal(pendingIgnored.json().rows[0].pending, false);
});

test("data station page script parses", () => {
  const html = fs.readFileSync(new URL("../src/platform/public/index.html", import.meta.url), "utf8");
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match);
  new Function(match[1]);
});

test("model id lists accept official payload shapes", () => {
  assert.deepEqual(modelIdsFrom({ models: ["a", { modelId: "b" }, { id: "c" }] }), ["a", "b", "c"]);
});
