const SCHEMA_VERSION = 3;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

export function configureDb(db) {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
}

// 规范化分析层。唯一的检测记录事实来源：probe_runs + probe_results（详情），
// 另有 sites / models 维度表与 run_sources 来源标记。旧版平表 probe_history
// 与 ingest_meta / ingest_log / current_cache 已在此版本废弃。
const NORMALIZED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS probe_runs (
    id TEXT PRIMARY KEY,
    base_url TEXT,
    site_id INTEGER,
    claimed_model_id TEXT,
    created_at TEXT,
    completed_at TEXT,
    source_report_url TEXT,
    raw_payload_ref TEXT,
    parser_version TEXT,
    ingested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS probe_results (
    run_id TEXT PRIMARY KEY REFERENCES probe_runs(id) ON DELETE CASCADE,
    model_id TEXT,
    actual_model TEXT,
    actual_family TEXT,
    verdict TEXT,
    score REAL,
    identity_confirmed INTEGER,
    confirmed_mismatch INTEGER,
    error_count INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER
  );
  CREATE TABLE IF NOT EXISTS run_sources (
    run_id TEXT NOT NULL REFERENCES probe_runs(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('public_history', 'my_submission')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (run_id, source_type)
  );
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL UNIQUE,
    base_url TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT,
    note TEXT,
    is_hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    family TEXT,
    canonical_id TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS my_submissions (
    run_id TEXT PRIMARY KEY REFERENCES probe_runs(id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL,
    key_alias TEXT,
    key_fingerprint TEXT,
    api_group TEXT,
    request_model TEXT
  );
  CREATE TABLE IF NOT EXISTS run_annotations (
    run_id TEXT PRIMARY KEY REFERENCES probe_runs(id) ON DELETE CASCADE,
    note TEXT,
    custom_tags TEXT NOT NULL DEFAULT '[]',
    conclusion TEXT NOT NULL DEFAULT 'unset',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_model_daily (
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    day TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    match_count INTEGER NOT NULL DEFAULT 0,
    family_match_count INTEGER NOT NULL DEFAULT 0,
    substitution_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    score_sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, model_id, day)
  );
  CREATE TABLE IF NOT EXISTS ingest_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    fetched INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    overlap INTEGER NOT NULL DEFAULT 0,
    detail_pending INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    missed INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS ingest_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_poll_at TEXT,
    lock_owner TEXT,
    lock_expires_at TEXT,
    current_interval_ms INTEGER NOT NULL DEFAULT 1800000,
    last_poll_at TEXT,
    last_success_at TEXT,
    previous_window_ids TEXT,
    last_error TEXT
  );
  INSERT OR IGNORE INTO ingest_state(id) VALUES (1);
  CREATE INDEX IF NOT EXISTS idx_probe_runs_created ON probe_runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_probe_runs_site ON probe_runs(site_id);
  CREATE INDEX IF NOT EXISTS idx_probe_results_model ON probe_results(model_id);
  CREATE INDEX IF NOT EXISTS idx_run_sources_type ON run_sources(source_type);
  CREATE INDEX IF NOT EXISTS idx_daily_day ON site_model_daily(day);
`;

export function migrateDb(db) {
  configureDb(db);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec(NORMALIZED_SCHEMA);

  // 废弃表清理：v1 时代曾用 CREATE TABLE IF NOT EXISTS 在 openDb 里额外建过
  // probe_history / ingest_meta / ingest_log / current_cache，并不在版本体系内，
  // 因此不按版本号判断，而是表存在即清（幂等，对新库无害）。
  dropDeprecatedTables(db);

  const current = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version || 0;
  if (current >= SCHEMA_VERSION) return current;

  if (current < 2) {
    // v1 → v2：把旧 ingest_meta 里的轮询参数并入 ingest_state 后整体删除。
    if (tableExists(db, "ingest_meta")) {
      if (columnExists(db, "ingest_meta", "value") && !columnExists(db, "ingest_state", "last_poll_at")) {
        db.exec("ALTER TABLE ingest_state ADD COLUMN last_poll_at TEXT");
      }
      db.exec(`
        UPDATE ingest_state SET
          current_interval_ms = COALESCE((SELECT value FROM ingest_meta WHERE key = 'interval_ms'), current_interval_ms),
          last_poll_at = (SELECT value FROM ingest_meta WHERE key = 'last_poll_at')
        WHERE id = 1
      `);
    }
  }

  if (current < 3) {
    if (!columnExists(db, "ingest_runs", "overlap")) {
      db.exec("ALTER TABLE ingest_runs ADD COLUMN overlap INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnExists(db, "ingest_state", "previous_window_ids")) {
      db.exec("ALTER TABLE ingest_state ADD COLUMN previous_window_ids TEXT");
    }
  }

  db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
  return SCHEMA_VERSION;
}

function dropDeprecatedTables(db) {
  db.exec(`
    DROP TABLE IF EXISTS ingest_meta;
    DROP TABLE IF EXISTS ingest_log;
    DROP TABLE IF EXISTS current_cache;
    DROP TABLE IF EXISTS probe_history;
  `);
}

export { SCHEMA_VERSION };
