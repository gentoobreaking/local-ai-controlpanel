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
