// SQLite 存取層（spec §27）。
// 使用 Node 內建 node:sqlite（DatabaseSync + FTS5），零原生相依。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    complexity TEXT,
    risk TEXT,
    sandbox_mode TEXT,
    flags TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    worker TEXT,
    model TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    claim TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    source_type TEXT NOT NULL,
    version TEXT,
    confidence REAL,
    relevance REAL,
    content_hash TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS evidence_sources (
    id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    uri TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    FOREIGN KEY (evidence_id) REFERENCES evidence(id)
);

CREATE TABLE IF NOT EXISTS verification_results (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    verifier TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    sandbox_mode TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    reason TEXT NOT NULL,
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    action TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost REAL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS patches (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL,
    diff TEXT,
    workspace_dir TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS reflections (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    classification TEXT NOT NULL,
    confidence REAL,
    recommended_action TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS worker_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    worker TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_memory (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_usage (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hallucination_evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    pattern_type TEXT NOT NULL,
    file_line TEXT,
    message TEXT,
    probe_result TEXT,
    pinned_version TEXT,
    reflection_class TEXT,
    sandbox_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_task ON verification_results(task_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
`;

export function createDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(`${dataDir}/control-plane.db`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
    claim, task_id UNINDEXED, content='evidence', content_rowid='rowid'
  );`);
  return db;
}