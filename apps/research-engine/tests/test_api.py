# -*- coding: utf-8 -*-
"""HTTP API integration tests（§12.4）：FastAPI app via Starlette TestClient.
FastAPI/httpx 未安裝時跳過。"""
import pathlib
import subprocess
import tempfile

import pytest

fastapi = pytest.importorskip("fastapi")
httpx = pytest.importorskip("httpx")
from starlette.testclient import TestClient

from research_engine.app import build_app


@pytest.fixture
def client(workspace):
  if fastapi is None:
    pytest.skip("FastAPI 未安裝")
  return TestClient(build_app())


def test_health(client):
  assert client.get("/health").json() == {"status": "ok", "service": "research-engine"}


def test_research_returns_bundle(client, workspace):
  r = client.post("/research", json={
    "taskId": "TASK-001", "request": "kubernetes deployment", "workspace": workspace, "risk": "high",
  })
  assert r.status_code == 200
  body = r.json()
  assert body["taskId"] == "TASK-001"
  assert len(body["queries"]) >= 1
  assert isinstance(body["bundle"]["facts"], list)


def test_query_plan(client):
  r = client.get("/query-plan?request_text=oauth+login&risk=low")
  assert r.status_code == 200
  assert any("oauth" in q for q in r.json()["queries"])


def test_evidence_endpoint_returns_stored_facts(client, workspace, tmp_path, monkeypatch):
  # 讓 engine 使用 tmp_path 的 DB，避免污染全域
  import os
  db = str(tmp_path / "mem.db")
  monkeypatch.setenv("RESEARCH_MEMORY_DB", db)
  from research_engine.app import _engine_once, ResearchEngine
  # 重建 engine 指向新 DB
  monkeypatch.setattr("research_engine.app._engine", None)
  r = client.post("/research", json={
    "taskId": "TASK-EVID", "request": "kubernetes deployment", "workspace": workspace,
  })
  assert r.status_code == 200
  e = client.get("/evidence/TASK-EVID")
  assert e.status_code == 200
  body = e.json()
  assert body["taskId"] == "TASK-EVID"
  assert body["count"] == len(body["facts"])


def test_evidence_policy_endpoint(client, tmp_path, monkeypatch):
  """policy 驅動：evidence.max_tokens / min_relevance 從 research.yaml 讀取。"""
  import os
  pdir = tmp_path / "policies"
  pdir.mkdir()
  (pdir / "research.yaml").write_text(
    "evidence:\n  max_tokens: 5000\n  min_relevance: 0.5\n  budget_percent: 0.4\n", encoding="utf-8")
  monkeypatch.setenv("RESEARCH_POLICY_DIR", str(pdir))
  r = client.get("/evidence-policy")
  assert r.status_code == 200
  body = r.json()
  assert body["max_tokens"] == 5000
  assert body["min_relevance"] == 0.5
  assert body["budget_percent"] == 0.4
