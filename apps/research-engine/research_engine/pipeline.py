# -*- coding: utf-8 -*-
"""Standardized research pipeline（spec §12/§13）：

Search → Retrieve → Extract → Normalize → Version filter → Deduplicate
      → Cross-check → Evidence
"""

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from .models import Evidence, EvidenceBundle
from .retrievers import (
  ALL_RETRIEVERS,
  GitHistoryRetriever,
  Retriever,
  RepositoryRetriever,
  WebRetriever,
  DocumentationRetriever,
  RetrieveHit,
  extract_claims,
  to_evidence,
)


@dataclass
class PipelineConfig:
  minimumSources: int = 2
  maxFacts: int = 200
  requiredSourceTypes: tuple[str, ...] = ()


SOURCE_PRIORITY = ["repository", "git_history", "documentation", "web"]
RETRIEVER_ORDER: list[Retriever] = [RepositoryRetriever(), GitHistoryRetriever(), DocumentationRetriever(), WebRetriever()]


def _source_rank(st: str) -> int:
  return SOURCE_PRIORITY.index(st) if st in SOURCE_PRIORITY else len(SOURCE_PRIORITY)


def run_pipeline(
  queries: list[str],
  workspace: str,
  config: PipelineConfig | None = None,
  retrievers: list[Retriever] | None = None,
) -> list[Evidence]:
  """執行標準 pipeline 回傳 Evidence 清單（未 bundle）。"""
  if config is None:
    config = PipelineConfig()
  retrievers = retrievers or RETRIEVER_ORDER
  # 1. Retrieve（依優先序）
  hits: list[RetrieveHit] = []
  for ret in retrievers:
    hits.extend(ret.retrieve(queries, workspace))

  # 2. Extract → 3. Normalize（切 claim）
  evidences: list[Evidence] = []
  for hit in hits:
    for claim in extract_claims(hit):
      evidences.append(to_evidence(hit, claim))

  # 4. Deduplicate（以 contentHash）
  seen: set[str] = set()
  dedup: list[Evidence] = []
  for e in evidences:
    key = e.contentHash
    if key in seen:
      continue
    seen.add(key)
    dedup.append(e)

  # 5. 依來源優先序 + relevance 排序
  dedup.sort(key=lambda e: (_source_rank(e.source.type), -(e.relevance + e.confidence)))

  # 6. Cross-check：來自多來源的相同 claim confidence 加權
  by_claim: dict[str, list[Evidence]] = {}
  for e in dedup:
    by_claim.setdefault(e.claim[:40], []).append(e)
  for e in dedup:
    siblings = by_claim.get(e.claim[:40], [])
    if len(siblings) >= 2:
      e.confidence = min(1.0, e.confidence + 0.1)

  if len(dedup) > config.maxFacts:
    dedup = dedup[: config.maxFacts]
  return dedup


def build_bundle(
  taskId: str,
  facts: list[Evidence],
  constraints: list[str],
  versions: dict[str, str] | None = None,
  unresolvedQuestions: list[str] | None = None,
  tokenBudget: int = 8000,
) -> EvidenceBundle:
  # token 估算（deterministic）：max(1, ceil(claim.length/4))
  import math

  estimated = sum(max(1, math.ceil(len(e.claim) / 4)) for e in facts)
  bundle = EvidenceBundle(
    id=f"bundle-{taskId[:8]}",
    taskId=taskId,
    facts=facts,
    constraints=constraints,
    versions=versions or {},
    unresolvedQuestions=unresolvedQuestions or [],
  confidence=_bundle_confidence(facts),
    generatedAt=datetime.now(timezone.utc).isoformat(),
    tokenBudget=tokenBudget,
    estimatedTokens=estimated,
    truncated=estimated > tokenBudget,
  )
  # Shaping（§12.2）：超過預算從低 priority facts 截斷（constraints/versions 保留）
  if bundle.truncated:
    kept: list[Evidence] = []
    budget = tokenBudget
    dropped: list[str] = []
    # constraints & versions 完整保留不計入 token
    for e in facts:
      tok = max(1, math.ceil(len(e.claim) / 4))
      if budget - tok >= 0:
        kept.append(e)
        budget -= tok
      else:
        dropped.append(e.id)
    bundle.facts = kept
    bundle.droppedFactIds = dropped
    extra = f"另有 {len(dropped)} 筆證據因超過 token 預算未提供"
    if extra not in bundle.unresolvedQuestions:
      bundle.unresolvedQuestions.append(extra)
  return bundle


def _bundle_confidence(facts: list[Evidence]) -> float:
  if not facts:
    return 0.0
  return sum(e.confidence * e.relevance for e in facts) / len(facts)
