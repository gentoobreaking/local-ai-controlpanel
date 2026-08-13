# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.engine import ResearchEngine, ResearchRequest
from research_engine.memory import ProjectMemory


def test_engine_returns_bundle_and_plan(workspace):
  eng = ResearchEngine()
  result = eng.research(ResearchRequest(taskId="TASK-1", request="kubernetes deployment", workspace=workspace, risk="medium", researchReasons=["external_api"]))
  assert result.taskId == "TASK-1"
  assert result.bundle.facts
  assert result.plan.queries


def test_engine_uses_project_memory_to_skip(workspace, tmp_path):
  mem = ProjectMemory(str(tmp_path / "mem.db"))
  mem.set("TASK-2", "constraints", ["preserve_existing_selector"])
  eng = ResearchEngine(memory=mem)
  result = eng.research(ResearchRequest(taskId="TASK-2", request="k8s", workspace=workspace))
  assert "preserve_existing_selector" in result.bundle.constraints
