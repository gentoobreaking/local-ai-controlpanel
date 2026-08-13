# -*- coding: utf-8 -*-
"""Evidence Model（spec §13）。

生產環境使用 Pydantic 序列化；為確保單元測試可在缺少 pydantic 時執行，
模型以 stdlib dataclasses 定義，並在 pydantic 可用時提供 from_dict/to_dict。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Source:
  type: str  # "official" | "repository" | "github" | "issue" | "web"
  uri: str
  title: str | None = None
  publisher: str | None = None


@dataclass
class Document:
  """標準化文件：來自任一 retriever。"""
  source: Source
  text: str
  version: str | None = None
  contentType: str = "text/plain"


@dataclass
class Evidence:
  id: str
  claim: str
  source: Source
  version: str | None = None
  confidence: float = 1.0      # 0..1
  relevance: float = 1.0      # 0..1
  retrievedAt: str = ""
  contentHash: str = ""       # sha1(text) truncated


@dataclass
class EvidenceBundle:
  id: str
  taskId: str
  facts: list[Evidence] = field(default_factory=list)
  constraints: list[str] = field(default_factory=list)
  versions: dict[str, str] = field(default_factory=dict)
  unresolvedQuestions: list[str] = field(default_factory=list)
  confidence: float = 0.0
  generatedAt: str = ""
  tokenBudget: int = 8000
  estimatedTokens: int = 0
  truncated: bool = False
  droppedFactIds: list[str] = field(default_factory=list)


def evidence_to_dict(e: Evidence) -> dict[str, Any]:
  d = asdict(e)
  d["source"] = asdict(e.source)
  return d


def evidence_from_dict(d: dict) -> Evidence:
  return Evidence(
    id=d["id"],
    claim=d["claim"],
    source=Source(**(d["source"])),
    version=d.get("version"),
    confidence=d.get("confidence", 1.0),
    relevance=d.get("relevance", 1.0),
    retrievedAt=d.get("retrievedAt", ""),
    contentHash=d.get("contentHash", ""),
  )


def bundle_to_dict(b: EvidenceBundle) -> dict[str, Any]:
  return {
    "id": b.id,
    "taskId": b.taskId,
    "facts": [evidence_to_dict(f) for f in b.facts],
    "constraints": b.constraints,
    "versions": b.versions,
    "unresolvedQuestions": b.unresolvedQuestions,
    "confidence": b.confidence,
    "generatedAt": b.generatedAt,
    "tokenBudget": b.tokenBudget,
    "estimatedTokens": b.estimatedTokens,
    "truncated": b.truncated,
    "droppedFactIds": b.droppedFactIds,
  }
