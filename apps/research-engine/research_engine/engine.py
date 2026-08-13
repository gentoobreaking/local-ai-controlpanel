# -*- coding: utf-8 -*-
"""Research Engine orchestrator（spec §12/§26）：
Query Planner → Project Memory（avoid redo）→ Retrieve → Pipeline → EvidenceBundle。
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import EvidenceBundle
from .pipeline import run_pipeline, build_bundle, PipelineConfig
from .query_planner import QueryPlan, plan_query


@dataclass
class ResearchRequest:
  taskId: str
  request: str
  workspace: str
  risk: str | None = None
  researchReasons: list[str] | None = None


@dataclass
class ResearchResult:
  taskId: str
  bundle: EvidenceBundle
  plan: QueryPlan


class ResearchEngine:
  def __init__(self, memory=None, config: PipelineConfig | None = None):
    self.memory = memory
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

    bundle = build_bundle(
      taskId=req.taskId,
      facts=facts,
      constraints=constraints,
      versions=versions,
      unresolvedQuestions=unresolved,
      tokenBudget=4000,
    )
    return ResearchResult(taskId=req.taskId, bundle=bundle, plan=plan)
