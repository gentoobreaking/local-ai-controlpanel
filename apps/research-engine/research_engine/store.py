# -*- coding: utf-8 -*-
"""Evidence Store（spec §27 evidence 表 + §13）：完整證據集持久化。

Shaping 只影響「交付給 Worker 的 bundle」，**Evidence Store 永遠保存完整證據集**
（§12.2 規則 5：gate 以完整證據集驗證，不受 shaping 截斷影響）。
"""

from __future__ import annotations

import json
import os
import sqlite3
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_type TEXT NOT NULL,
  version TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  relevance REAL NOT NULL DEFAULT 1.0,
  content_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
"""


class EvidenceStore:
  """SQLite evidence 表（§27）。同一 DB 檔案可與 project_memory 共用。"""

  def __init__(self, dbPath: str):
    self.dbPath = dbPath
    os.makedirs(os.path.dirname(dbPath) or ".", exist_ok=True)
    self.db = sqlite3.connect(dbPath)
    for stmt in SCHEMA.split(";"):
      stmt = stmt.strip()
      if stmt:
        self.db.execute(stmt)
    self.db.commit()

  def _now(self) -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

  def save_bundle(self, taskId: str, facts: list[Any]) -> int:
    """寫入完整證據集（bundle 交付前呼叫；shaping 後不覆蓋）。回傳寫入筆數。"""
    now = self._now()
    inserted = 0
    for e in facts:
      try:
        self.db.execute(
          "INSERT OR IGNORE INTO evidence "
          "(id, task_id, claim, source_uri, source_type, version, confidence, relevance, content_hash, created_at) "
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          (
            e.id,
            taskId,
            e.claim,
            e.source.uri,
            e.source.type,
            e.version,
            e.confidence,
            e.relevance,
            e.contentHash or e.id,
            now,
          ),
        )
        inserted += 1
      except sqlite3.IntegrityError:
        # id 衝突（跨 task 相同 hash）：保留既有，不覆寫
        continue
    self.db.commit()
    return inserted

  def facts_for_task(self, taskId: str) -> list[dict[str, Any]]:
    rows = self.db.execute(
      "SELECT id, claim, source_uri, source_type, version, confidence, relevance, content_hash, created_at "
      "FROM evidence WHERE task_id = ? ORDER BY confidence * relevance DESC, created_at",
      (taskId,),
    ).fetchall()
    return [
      {
        "id": r[0],
        "claim": r[1],
        "source": {"uri": r[2], "type": r[3]},
        "version": r[4],
        "confidence": r[5],
        "relevance": r[6],
        "contentHash": r[7],
        "retrievedAt": r[8],
      }
      for r in rows
    ]

  def count(self, taskId: str) -> int:
    row = self.db.execute(
      "SELECT COUNT(*) FROM evidence WHERE task_id = ?", (taskId,)
    ).fetchone()
    return int(row[0]) if row else 0
