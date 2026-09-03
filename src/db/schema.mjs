const SCHEMA_VERSION = 9;

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
    ingested_at TEXT NOT NULL,
    run_uuid TEXT,
    is_public INTEGER NOT NULL DEFAULT 0
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
    output_tokens INTEGER,
    identity_only INTEGER,
    total_probes INTEGER
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
    is_favorite INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS run_enrichment_jobs (
    run_id TEXT PRIMARY KEY REFERENCES probe_runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    updated_at TEXT NOT NULL
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
    reason TEXT,
    fetched INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS ingest_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_poll_at TEXT,
    last_success_at TEXT,
    last_error TEXT
  );
  INSERT OR IGNORE INTO ingest_state(id) VALUES (1);
  CREATE INDEX IF NOT EXISTS idx_probe_runs_created ON probe_runs(created_at);
  CREATE INDEX IF NOT EXISTS idx_probe_runs_created_id ON probe_runs(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_probe_runs_site ON probe_runs(site_id);
  CREATE INDEX IF NOT EXISTS idx_probe_results_model ON probe_results(model_id);
  CREATE INDEX IF NOT EXISTS idx_run_sources_type ON run_sources(source_type);
  CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_due ON run_enrichment_jobs(status, next_attempt_at);
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

  // Repair by shape as well as version so partially applied/restored databases converge.
  // v8：调度改到进程内，ingest_state 只留最近一次拉取的状态；ingest_runs 记触发原因。
  for (const col of ["next_poll_at", "lock_owner", "lock_expires_at", "current_interval_ms", "previous_window_ids"]) {
    if (columnExists(db, "ingest_state", col)) db.exec(`ALTER TABLE ingest_state DROP COLUMN ${col}`);
  }
  for (const col of ["overlap", "detail_pending", "missed"]) {
    if (columnExists(db, "ingest_runs", col)) db.exec(`ALTER TABLE ingest_runs DROP COLUMN ${col}`);
  }
  if (!columnExists(db, "ingest_runs", "reason")) {
    db.exec("ALTER TABLE ingest_runs ADD COLUMN reason TEXT");
  }
  if (!columnExists(db, "ingest_state", "last_poll_at")) {
    db.exec("ALTER TABLE ingest_state ADD COLUMN last_poll_at TEXT");
  }
  if (!columnExists(db, "sites", "is_favorite")) {
    db.exec("ALTER TABLE sites ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnExists(db, "probe_runs", "run_uuid")) {
    db.exec("ALTER TABLE probe_runs ADD COLUMN run_uuid TEXT");
  }
  if (!columnExists(db, "probe_results", "identity_only")) {
    db.exec("ALTER TABLE probe_results ADD COLUMN identity_only INTEGER");
  }
  if (!columnExists(db, "probe_results", "total_probes")) {
    db.exec("ALTER TABLE probe_results ADD COLUMN total_probes INTEGER");
  }
  // v9：公开来源标记落到 probe_runs 上，让列表的 COUNT / 过滤不再逐行查 run_sources。
  // 索引以 ingested_at 为前导列，避免规划器在翻页时误选它而放弃 (created_at, id)。
  if (!columnExists(db, "probe_runs", "is_public")) {
    db.exec("ALTER TABLE probe_runs ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE probe_runs SET is_public = 1 WHERE id IN (SELECT run_id FROM run_sources WHERE source_type = 'public_history')");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_probe_runs_uuid ON probe_runs(run_uuid) WHERE run_uuid IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_probe_runs_created_id ON probe_runs(created_at DESC, id DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_probe_runs_ingested_public ON probe_runs(ingested_at, is_public)");

  if (current >= SCHEMA_VERSION) return current;

  if (current < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_enrichment_jobs (
        run_id TEXT PRIMARY KEY REFERENCES probe_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_due ON run_enrichment_jobs(status, next_attempt_at);
    `);
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
