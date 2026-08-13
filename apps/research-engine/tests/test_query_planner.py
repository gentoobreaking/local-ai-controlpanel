# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.query_planner import plan_query


def test_basic_query_from_request():
  plan = plan_query("add kubernetes deployment support", "medium", [])
  assert plan.queries
  assert any("kubernetes" in q.text for q in plan.queries)
  assert plan.risk == "medium"


def test_unknown_dependency_reasons_generate_extra_query():
  plan = plan_query("use a new db driver", "high", ["unknown_dependency"])
  # 至少有一個 query 帶入 dependency 關鍵詞
  assert len(plan.queries) >= 2
  joined = " ".join(q.text for q in plan.queries)
  assert "dependency" in joined


def test_keywords_extracted():
  plan = plan_query("implement OAuth login", None, [])
  # keywords 不可空
  assert all(q.keywords for q in plan.queries)


def test_empty_request_still_produces_a_query():
  plan = plan_query("", None, [])
  assert len(plan.queries) >= 1
