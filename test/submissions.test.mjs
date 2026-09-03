import assert from "node:assert/strict";
import test from "node:test";
import { keyFingerprint, normalizeSubmission } from "../src/core/submissions.mjs";
import { submissionFromProbe } from "../src/mirror/server.mjs";

test("mirror capture produces a sanitized submission event", () => {
  const request = Buffer.from(JSON.stringify({
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-super-secret",
    modelId: "anthropic/claude-opus-5",
  }));
  const response = Buffer.from(JSON.stringify({ runId: "run-123", status: "queued" }));
  const event = submissionFromProbe(request, response);
  assert.deepEqual(event, {
    runId: "run-123",
    baseUrl: "https://relay.example/v1",
    requestModel: "anthropic/claude-opus-5",
    keyFingerprint: null,
  });
  assert.equal(JSON.stringify(event).includes("sk-super-secret"), false);
});

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
