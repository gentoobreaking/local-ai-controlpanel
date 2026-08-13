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
  # Version filter（§12）：以指定版本優先。None = 不篩選。
  targetVersion: str | None = None


def version_priority(version: str | None, target: str | None) -> int:
  """Version filter 排序鍵：命中 target 優先（0），其次有版本（1），無版本最後（2）。"""
  if target and version:
    return 0 if target in version or version in target else 1
  if version:
    return 1
  return 2


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

  # 5. Version filter（§12）：targetVersion 指定時優先保留命中版本
  #    （不丟棄其他版本——低優先排序，保留於 store；shaping 依此順序截斷）
  if config.targetVersion:
    dedup.sort(key=lambda e: (
      version_priority(e.version, config.targetVersion),
      _source_rank(e.source.type),
      -(e.relevance + e.confidence),
    ))
  else:
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


def estimate_tokens(claim: str) -> int:
  """token 估算（deterministic，§13）：max(1, ceil(claim.length/4))。
  禁止 LLM 逐條估算。"""
  return max(1, math.ceil(len(claim) / 4))


def build_bundle(
  taskId: str,
  facts: list[Evidence],
  constraints: list[str],
  versions: dict[str, str] | None = None,
  unresolvedQuestions: list[str] | None = None,
  tokenBudget: int = 8000,
  minRelevance: float = 0.0,
) -> EvidenceBundle:
  """Evidence Shaping（§12.2，確定性規則，不可由 LLM 決定）：

  1. constraints / versions 完整保留（優先度最高，不可截斷）
  2. facts 依 relevance × confidence 由高到低保留，直到 token 預算用盡
  3. unresolvedQuestions 摘要式單行（完整保留）
  4. 截斷 → truncated=true + droppedFactIds；unresolvedQuestions 追加「另有 N 筆...」
  """
  # min_relevance 過濾（§30 evidence.min_relevance；確定性門檻）
  kept_facts = [e for e in facts if e.relevance >= minRelevance]
  dropped_low_relevance = [e.id for e in facts if e.relevance < minRelevance]

  # 依 relevance × confidence 由高到低排序（shaping 截斷順序）
  ranked = sorted(
    kept_facts,
    key=lambda e: (e.relevance * e.confidence, e.relevance, e.confidence),
    reverse=True,
  )

  estimated = sum(estimate_tokens(e.claim) for e in ranked)
  bundle = EvidenceBundle(
    id=f"bundle-{taskId[:8]}",
    taskId=taskId,
    facts=ranked,
    constraints=constraints,
    versions=versions or {},
    unresolvedQuestions=unresolvedQuestions or [],
    confidence=_bundle_confidence(ranked),
    generatedAt=datetime.now(timezone.utc).isoformat(),
    tokenBudget=tokenBudget,
    estimatedTokens=estimated,
    truncated=estimated > tokenBudget,
  )

  # 截斷（§12.2）：從低分 facts 開始丟，constraints/versions 完整保留
  dropped: list[str] = list(dropped_low_relevance)
  if bundle.truncated:
    kept: list[Evidence] = []
    budget = tokenBudget
    for e in ranked:
      tok = estimate_tokens(e.claim)
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
  elif dropped_low_relevance:
    # 低 relevance 被門檻過濾（未觸發 token 截斷）——也須記錄，避免靜默遺失
    bundle.droppedFactIds = dropped_low_relevance
    extra = f"另有 {len(dropped_low_relevance)} 筆證據因低 relevance（<{minRelevance}）未提供"
    if extra not in bundle.unresolvedQuestions:
      bundle.unresolvedQuestions.append(extra)
  return bundle


def _bundle_confidence(facts: list[Evidence]) -> float:
  if not facts:
    return 0.0
  return sum(e.confidence * e.relevance for e in facts) / len(facts)
