# -*- coding: utf-8 -*-
"""Evidence Shaping 測試（spec §12.2 / §13）：確定性規則。"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.models import Evidence, Source
from research_engine.pipeline import build_bundle, estimate_tokens


def _fact(i: int, confidence=1.0, relevance=1.0, length=60) -> Evidence:
  return Evidence(
    id=f"f{i}",
    claim=f"c{i} " + "x" * length,
    source=Source(type="repository", uri=f"/w/{i}.py", title=f"{i}.py"),
    confidence=confidence,
    relevance=relevance,
  )


def test_estimate_tokens_deterministic():
  # max(1, ceil(len/4))
  assert estimate_tokens("abcd") == 1
  assert estimate_tokens("abcde") == 2   # ceil(5/4) = 2
  assert estimate_tokens("") == 1        # max(1, 0)


def test_shaping_keeps_constraints_and_versions_when_truncated():
  """§12.2：constraints / versions 完整保留，即使 facts 被截斷。"""
  facts = [_fact(i, length=400) for i in range(30)]
  bundle = build_bundle(
    taskId="T1",
    facts=facts,
    constraints=["preserve_existing_selector", "do_not_modify_service"],
    versions={"kubernetes": "1.34", "sdk": "2.1"},
    tokenBudget=100,
  )
  assert bundle.truncated
  assert bundle.constraints == ["preserve_existing_selector", "do_not_modify_service"]
  assert bundle.versions == {"kubernetes": "1.34", "sdk": "2.1"}
  assert bundle.droppedFactIds
  # 追加「另有 N 筆...」說明
  assert any("另有" in q and "未提供" in q for q in bundle.unresolvedQuestions)
  # 交付的 facts 都 <= budget
  assert sum(estimate_tokens(e.claim) for e in bundle.facts) <= bundle.tokenBudget


def test_shaping_ranks_by_relevance_times_confidence():
  """§12.2：facts 依 relevance×confidence 由高到低保留。"""
  facts = [
    _fact(1, confidence=0.9, relevance=0.9),   # 0.81
    _fact(2, confidence=1.0, relevance=0.5),   # 0.50
    _fact(3, confidence=0.5, relevance=0.5),   # 0.25
  ]
  bundle = build_bundle(taskId="T1", facts=facts, constraints=[], tokenBudget=100)
  # 排序後：f1, f2, f3（高分在前）
  assert [e.id for e in bundle.facts] == ["f1", "f2", "f3"]


def test_shaping_truncates_lowest_score_first():
  """預算極小：最低分 fact 先被丟。"""
  facts = [
    _fact(1, confidence=1.0, relevance=1.0, length=100),  # 高（~26 tokens）
    _fact(2, confidence=0.2, relevance=0.2, length=400),  # 低（~101 tokens）
  ]
  bundle = build_bundle(taskId="T1", facts=facts, constraints=[], tokenBudget=120)
  assert bundle.truncated
  assert "f2" in bundle.droppedFactIds
  # 高分的 f1 被保留
  assert [e.id for e in bundle.facts] == ["f1"]


def test_min_relevance_filter_policy_driven():
  """§30 evidence.min_relevance：低 relevance 被過濾並記錄。"""
  facts = [
    _fact(1, relevance=0.9),
    _fact(2, relevance=0.1),
  ]
  bundle = build_bundle(taskId="T1", facts=facts, constraints=[], tokenBudget=1000, minRelevance=0.3)
  assert not bundle.truncated
  assert [e.id for e in bundle.facts] == ["f1"]
  assert bundle.droppedFactIds == ["f2"]
  assert any("低 relevance" in q for q in bundle.unresolvedQuestions)


def test_estimated_tokens_matches_sum():
  bundle = build_bundle(taskId="T1", facts=[_fact(1), _fact(2)], constraints=[], tokenBudget=1000)
  assert bundle.estimatedTokens == sum(estimate_tokens(e.claim) for e in bundle.facts)
