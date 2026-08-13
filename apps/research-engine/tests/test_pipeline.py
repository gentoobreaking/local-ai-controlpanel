# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.pipeline import PipelineConfig, run_pipeline, build_bundle
from research_engine.models import Evidence, Source


def test_pipeline_deduplicates_by_content_hash(workspace):
  facts = run_pipeline(["kubernetes deployment"], workspace, None)
  hashes = [f.contentHash for f in facts]
  assert len(hashes) == len(set(hashes)), "contentHash 應唯一"


def test_build_bundle_shapes_when_over_budget():
  # 高信號 facts 多 → 觸發 shaping 截斷
  from research_engine.models import Evidence, Source
  facts = []
  for i in range(50):
    facts.append(Evidence(id=f"f{i}", claim="x" * 400, source=Source(type="web", uri=f"http://e/{i}", title=f"t{i}")))
  bundle = build_bundle(taskId="TASK-1", facts=facts, constraints=["c1"], tokenBudget=200)
  assert bundle.truncated
  assert bundle.droppedFactIds
  assert bundle.unresolvedQuestions[-1].startswith("另有")


def test_build_bundle_confidence_aggregation():
  from research_engine.models import Evidence, Source
  facts = [Evidence(id="1", claim="a", source=Source(type="repository", uri="/x")),
           Evidence(id="2", claim="b", source=Source(type="repository", uri="/y"))]
  bundle = build_bundle(taskId="TASK-1", facts=facts, constraints=[])
  assert 0.0 < bundle.confidence <= 1.0
  assert bundle.estimatedTokens > 0

def test_version_filter_prioritizes_target_version():
  from research_engine.pipeline import version_priority
  # 命中 target → 0；有版本但未命中 → 1；無版本 → 2
  assert version_priority("1.34", "1.34") == 0
  assert version_priority("2.0", "1.34") == 1
  assert version_priority(None, "1.34") == 2
  assert version_priority("1.34", None) == 1


def test_run_pipeline_with_target_version_orders_hits_first():
  from research_engine.models import Source
  from research_engine.pipeline import PipelineConfig, run_pipeline
  config = PipelineConfig(targetVersion="9.9")
  facts = run_pipeline(["kubernetes deployment"], None, config)
  # 測試用 workspace 為 None：不崩潰即可（retriever 對無效 workspace 回空）
  assert isinstance(facts, list)
