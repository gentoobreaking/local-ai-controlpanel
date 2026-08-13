# -*- coding: utf-8 -*-
"""Research Engine orchestrator（spec §12/§26/§13）：
Query Planner → Project Memory（avoid redo）→ Retrieve → Pipeline →
Evidence Store（完整保存）→ Shaping（§12.2）→ EvidenceBundle。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .models import EvidenceBundle
from .pipeline import run_pipeline, build_bundle, PipelineConfig
from .query_planner import QueryPlan, plan_query
from .store import EvidenceStore


# §30 evidence policy 預設值（可由 policy 驅動，見 app.py 的 read_evidence_policy）
DEFAULT_EVIDENCE_POLICY = {
  "max_tokens": 8000,
  "min_relevance": 0.3,
  "budget_percent": 0.4,
}


@dataclass
class ResearchRequest:
  taskId: str
  request: str
  workspace: str
  risk: str | None = None
  researchReasons: list[str] | None = None
  evidencePolicy: dict | None = None


@dataclass
class ResearchResult:
  taskId: str
  bundle: EvidenceBundle
  plan: QueryPlan
  storeCount: int = 0


class ResearchEngine:
  def __init__(self, memory=None, store: EvidenceStore | None = None, config: PipelineConfig | None = None):
    self.memory = memory
    self.store = store
    self.config = config or PipelineConfig()

  def research(self, req: ResearchRequest) -> ResearchResult:
    reasons = req.researchReasons or []
    plan = plan_query(req.request, req.risk, reasons)
    queries = [q.text for q in plan.queries]

    # §26 Project Memory：查已知 facts，避免重查
    constraints: list[str] = []
    versions: dict[str, str] = {}
    unresolved: list[str] = []
    if self.memory:
      known = self.memory.knowns(req.taskId, ["constraints", "versions", "unresolved_questions"])
      if known.get("constraints"):
        constraints = known["constraints"]
      if known.get("versions"):
        versions = known["versions"]
      if known.get("unresolved_questions"):
        unresolved = known["unresolved_questions"]

    facts = run_pipeline(queries, req.workspace, self.config)
    if facts:
      if not constraints:
        constraints = [f"based_on: {req.request[:60]}"]
      for r in facts[:3]:
        versions.setdefault("latest_fact", r.source.type)

    # Evidence policy（§30）：max_tokens / min_relevance 由 policy 驅動
    pol = {**DEFAULT_EVIDENCE_POLICY, **(req.evidencePolicy or {})}
    token_budget = int(pol.get("max_tokens", 8000))
    min_relevance = float(pol.get("min_relevance", 0.0))

    # Evidence Store（§27）：先寫入完整證據集，再 shaping（§12.2 規則 5）
    store_count = 0
    if self.store:
      store_count = self.store.save_bundle(req.taskId, facts)

    bundle = build_bundle(
      taskId=req.taskId,
      facts=facts,
      constraints=constraints,
      versions=versions,
      unresolvedQuestions=unresolved,
      tokenBudget=token_budget,
      minRelevance=min_relevance,
    )
    return ResearchResult(taskId=req.taskId, bundle=bundle, plan=plan, storeCount=store_count)
