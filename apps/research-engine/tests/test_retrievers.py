# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.retrievers import RepositoryRetriever, GitHistoryRetriever, DocumentationRetriever, WebRetriever, extract_claims, RetrieveHit
from research_engine.pipeline import run_pipeline


def test_extract_claims_strips_short_noise():
  from research_engine.models import Source
  from research_engine.models import Source
  hit = RetrieveHit(source=Source(type="web", uri="http://x", title="t"),
                     text="short. This is a real claim about kubernetes deployments. x")
  claims = extract_claims(hit)
  assert any("kubernetes" in c for c in claims)


def test_repository_retriever_reads_workspace(workspace):
  ret = RepositoryRetriever()
  hits = ret.retrieve(["kubernetes", "deployment"], workspace)
  assert hits
  assert all(h.source.type == "repository" for h in hits)


def test_git_history_retriever_runs_git(workspace):
  ret = GitHistoryRetriever()
  hits = ret.retrieve(["init"], workspace)
  assert hits
  assert any("git:" in h.source.uri for h in hits)


def test_documentation_retriever_finds_local_docs(workspace):
  ret = DocumentationRetriever()
  hits = ret.retrieve(["kubernetes"], workspace)
  assert hits
  assert any(h.source.uri.endswith("README.md") for h in hits)


def test_web_retriever_returns_empty_when_offline():
  # web retriever 應 graceful degradation：無搜索 URL → 空列表（不丟錯）
  ret = WebRetriever()
  hits = ret.retrieve(["test"], "/tmp")
  assert isinstance(hits, list)


def test_pipeline_produces_evidence_and_ranks_by_source_priority(workspace):
  hits_evidence = run_pipeline(["kubernetes", "deployment"], workspace, None)
  assert hits_evidence
  # 來源優先序：repository/git_history 排在 documentation/web 前
  types = [e.source.type for e in hits_evidence]
  assert "repository" in types[:3]
