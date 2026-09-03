import assert from "node:assert/strict";
import test from "node:test";
import { keyFingerprint, normalizeSubmission } from "../src/core/submissions.mjs";
import { buildRunBody, displayScore, liveProgress } from "../src/core/probe-run.mjs";

test("submission normalization validates URLs and fingerprints keys with HMAC", () => {
  const fingerprint = keyFingerprint("sk-secret", "server-secret");
  assert.equal(fingerprint.length, 24);
  assert.equal(fingerprint.includes("sk-secret"), false);
  const normalized = normalizeSubmission({
    runId: "run-1",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-secret",
  }, { now: "2026-09-03T00:00:00Z", fingerprintSecret: "server-secret" });
  assert.equal(normalized.keyFingerprint, fingerprint);
  assert.equal("apiKey" in normalized, false);
  assert.throws(() => normalizeSubmission({ runId: "run-2", baseUrl: "file:///tmp/key" }), /http or https/);
});

test("official run body keeps the key only for the outbound request", () => {
  const body = buildRunBody({
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-secret",
    modelId: "anthropic/claude-opus-5",
    mode: "quick",
  });
  assert.equal(body.quickMode, true);
  assert.equal(body.modelId, "anthropic/claude-opus-5");
  assert.throws(() => buildRunBody({ baseUrl: "https://relay.example/v1", modelId: "x" }), /required/);
});

test("score and live progress match the official display scale", () => {
  assert.equal(displayScore(0.81), 81);
  assert.equal(displayScore(81), 81);
  assert.equal(displayScore(null), null);
  assert.deepEqual(liveProgress({ totalProbes: 98, items: [{ passed: true }, { passed: false }, { status: "running" }] }), {
    done: 2,
    total: 98,
    percent: 2,
  });
});
