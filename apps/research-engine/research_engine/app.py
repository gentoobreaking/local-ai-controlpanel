# -*- coding: utf-8 -*-
"""Research Engine HTTP API（spec §12.4）：Control Plane 唯一跨語言 IPC。

生產使用 FastAPI / uvicorn；bind 127.0.0.1（§28：唯 Research Engine 有網）。
環境變數：
  RESEARCH_PORT（預設 8090）
  RESEARCH_WORKSPACE_ROOT（預設 /tmp）
  RESEARCH_MEMORY_DB（預設 $RESEARCH_WORKSPACE_ROOT/.acp-research/memory.db）
"""

from __future__ import annotations

import os

from .models import bundle_to_dict
from .engine import ResearchEngine, ResearchRequest

_engine: ResearchEngine | None = None


def _engine_once() -> ResearchEngine:
  global _engine
  if _engine is None:
    from .memory import ProjectMemory
    ws = os.environ.get("RESEARCH_WORKSPACE_ROOT", "/tmp")
    db = os.environ.get("RESEARCH_MEMORY_DB", os.path.join(ws, ".acp-research", "memory.db"))
    _engine = ResearchEngine(memory=ProjectMemory(db))
  return _engine


try:
  from fastapi import FastAPI
  from fastapi.responses import JSONResponse
except ImportError:  # pragma: no cover - production path only
  FastAPI = None  # type: ignore[assignment]


def build_app():
  if FastAPI is None:
    raise RuntimeError("FastAPI 未安裝：pip install -e '.[test]'")
  app = FastAPI(title="acp-research-engine", version="0.5.0")

  @app.get("/health")
  async def health():
    return {"status": "ok", "service": "research-engine"}

  @app.post("/research")
  async def research(body: dict):
    req = ResearchRequest(
      taskId=body.get("taskId", "TASK-000"),
      request=body.get("request", ""),
      workspace=body.get("workspace", os.getcwd()),
      risk=body.get("risk"),
      researchReasons=body.get("researchReasons"),
    )
    result = _engine_once().research(req)
    return JSONResponse(content={
      "taskId": result.taskId,
      "bundle": bundle_to_dict(result.bundle),
      "queries": [q.text for q in result.plan.queries],
    })

  @app.get("/query-plan")
  async def query_plan(request_text: str, risk: str | None = None):
    from .query_planner import plan_query
    plan = plan_query(request_text, risk, [])
    return {"queries": [q.text for q in plan.queries], "risk": plan.risk}

  return app


app = build_app() if FastAPI is not None else None  # type: ignore[assignment]


def main():
  if app is None:
    raise RuntimeError("FastAPI/uvicorn 未安裝")
  import uvicorn
  port = int(os.environ.get("RESEARCH_PORT", "8090"))
  uvicorn.run("research_engine.app:app", host="127.0.0.1", port=port)


if __name__ == "__main__":
  main()
