# -*- coding: utf-8 -*-
"""Project Memory（spec §26）：SQLite 快取已知專案事實，避免重查。"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass, asdict
from typing import Any


@dataclass
class Fact:
  project: str
  key: str
  value: Any
  source: str = "research"
  updatedAt: str = ""

  def to_dict(self) -> dict:
    return asdict(self)


SCHEMA = """
CREATE TABLE IF NOT EXISTS project_memory (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, key)
)
"""


class ProjectMemory:
  def __init__(self, dbPath: str):
    self.dbPath = dbPath
    os.makedirs(os.path.dirname(dbPath) or ".", exist_ok=True)
    self.db = sqlite3.connect(dbPath)
    self.db.execute(SCHEMA)
    self.db.commit()

  def _now(self) -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

  def get(self, project: str, key: str) -> Any:
    row = self.db.execute("SELECT value FROM project_memory WHERE project=? AND key=? ORDER BY updated_at DESC LIMIT 1", (project, key)).fetchone()
    return json.loads(row[0]) if row else None

  def set(self, project: str, key: str, value: Any, source: str = "research") -> Fact:
    self.db.execute(
      "INSERT INTO project_memory (project, key, value, source, updated_at) VALUES (?, ?, ?, ?, ?) "
      "ON CONFLICT(project, key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at",
      (project, key, json.dumps(value), source, self._now()),
    )
    self.db.commit()
    return Fact(project=project, key=key, value=value, source=source, updatedAt=self._now())

  def knowns(self, project: str, keys: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in keys:
      v = self.get(project, k)
      if v is not None:
        out[k] = v
    return out
