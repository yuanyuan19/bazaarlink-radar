import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDb } from "../src/db/schema.mjs";
import { savePublicObservation } from "../src/db/repository.mjs";
import { bootPublicHistory, queryPublicHistory } from "../src/db/history-query.mjs";
import { handleHistoryRoute } from "../src/mirror/history-api.mjs";
import { officialProbeCopy } from "../src/probe/probe-copy.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazaarlink-history-"));
  const dbFile = path.join(dir, "test.sqlite");
  const db = new DatabaseSync(dbFile);
  migrateDb(db);
  for (let i = 0; i < 5; i++) {
    savePublicObservation(db, {
      id: `public-${i}`,
      baseUrl: `https://relay-${i}.example/v1`,
      modelId: "anthropic/claude-opus-5",
      createdAt: `2026-09-0${i + 1}T10:00:00Z`,
      identityConfirmed: true,
      score: 0.5 + i * 0.1,
    }, `2026-09-0${i + 1}T10:01:00Z`);
  }
  db.close();
  return { dir, dbFile };
}

test("queryPublicHistory filters by q and band", () => {
  const { dir, dbFile } = fixture();
  const db = new DatabaseSync(dbFile);
  try {
    const all = queryPublicHistory(db, { limit: 10 });
    assert.equal(all.total, 5);

    const host = queryPublicHistory(db, { q: "relay-2", limit: 10 });
    assert.equal(host.total, 1);
    assert.equal(host.history[0].id, "public-2");

    const high = queryPublicHistory(db, { band: "80", limit: 10 });
    assert.ok(high.total >= 1);
    for (const row of high.history) {
      assert.ok(row.displayScore >= 80);
    }

    const boot = bootPublicHistory(db, 2, ["public-0"]);
    assert.equal(boot.history.length, 2);
    assert.ok(boot.history.every((row) => row.id !== "public-0"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleHistoryRoute serves boot and paginated history", () => {
  const { dir, dbFile } = fixture();
  const db = new DatabaseSync(dbFile);
  try {
    const boot = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/history-boot.json?limit=3"));
    assert.equal(boot.history.length, 3);
    assert.equal(boot.total, 5);

    const page = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/history.json?offset=3&limit=2"));
    assert.equal(page.history.length, 2);
    assert.equal(page.offset, 3);

    const copy = handleHistoryRoute(db, new URL("http://127.0.0.1/__bl/probe-copy.json"));
    assert.equal(copy.history.histBand80, officialProbeCopy.history.histBand80);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history-virt.js parses", () => {
  const js = fs.readFileSync(new URL("../src/mirror/inject/history-virt.js", import.meta.url), "utf8");
  new Function(js);
});
