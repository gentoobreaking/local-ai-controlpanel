# -*- coding: utf-8 -*-
"""Evidence Store 測試（spec §27 evidence 表 / §12.2 規則 5）。"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.store import EvidenceStore
from research_engine.models import Evidence, Source


def _fact(i: int, confidence=1.0, relevance=1.0) -> Evidence:
  return Evidence(
    id=f"f{i}",
    claim=f"claim number {i} with enough length to be stored",
    source=Source(type="repository", uri=f"/workspace/file{i}.py", title=f"file{i}.py"),
    confidence=confidence,
    relevance=relevance,
  )


def test_store_roundtrip(tmp_path):
  store = EvidenceStore(str(tmp_path / "evidence.db"))
  facts = [_fact(1), _fact(2)]
  n = store.save_bundle("TASK-1", facts)
  assert n == 2
  got = store.facts_for_task("TASK-1")
  assert len(got) == 2
  assert got[0]["claim"] == facts[0].claim
  assert store.count("TASK-1") == 2


def test_store_keeps_full_set_even_when_bundle_truncated(tmp_path):
  """§12.2 規則 5：shaping 截斷不影響 Evidence Store 完整保存。"""
  from research_engine.pipeline import build_bundle
  store = EvidenceStore(str(tmp_path / "evidence.db"))
  facts = [_fact(i) for i in range(30)]
  store.save_bundle("TASK-2", facts)
  bundle = build_bundle(taskId="TASK-2", facts=facts, constraints=["c"], tokenBudget=100)
  assert bundle.truncated
  assert len(bundle.droppedFactIds) > 0
  # Store 仍是完整 30 筆
  assert store.count("TASK-2") == 30
  assert len(store.facts_for_task("TASK-2")) == 30


def test_store_insert_or_ignore_duplicate_id(tmp_path):
  store = EvidenceStore(str(tmp_path / "evidence.db"))
  store.save_bundle("TASK-3", [_fact(1)])
  store.save_bundle("TASK-3", [_fact(1)])
  assert store.count("TASK-3") == 1


def test_store_tasks_isolated(tmp_path):
  store = EvidenceStore(str(tmp_path / "evidence.db"))
  store.save_bundle("TASK-A", [_fact(1)])
  store.save_bundle("TASK-B", [_fact(2)])
  assert store.count("TASK-A") == 1
  assert store.count("TASK-B") == 1
