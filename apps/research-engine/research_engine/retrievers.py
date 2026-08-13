# -*- coding: utf-8 -*-
"""Retrievers（spec §12.1）與標準化 pipeline（§12 §13）。

來源優先序：repo → git history → package metadata/dependency → official docs →
GitHub upstream → trusted → web。Web 是最後手段。

本地 retriever（Repository / Git History / Documentation local）僅依賴標準庫；
Web / Documentation HTTP retriever 於函數內遅驻 import httpx/bs4/trafilatura，
如未安裝則回傳空結果而非失敗（graceful degradation，§14.2）。
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Protocol

from .models import Document, Evidence, Source


def _now() -> str:
  return datetime.now(timezone.utc).isoformat()


def _hash(text: str) -> str:
  return hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:12]


@dataclass
class RetrieveHit:
  """Raw retrieve 結果，來源 uri + 文本。"""
  source: Source
  text: str
  version: str | None = None
  contentType: str = "text/plain"


class Retriever(Protocol):
  name: str

  def retrieve(self, queries: list[str], workspace: str) -> list[RetrieveHit]:
    ...


def _read_files(workspace: str | None, patterns: list[str], limit: int = 20) -> list[tuple[str, str]]:
  import pathlib

  hits: list[tuple[str, str]] = []
  if not workspace:
    return hits
  root = pathlib.Path(workspace)
  if not root.exists():
    return hits
  for p in root.rglob("*"):
    if len(hits) >= limit:
      break
    if p.is_dir():
      continue
    name = p.name
    if name.startswith(".") or name in {"node_modules"}:
      continue
    try:
      if name.endswith((".md", ".txt", ".py", ".ts", ".go", ".toml", ".yaml", ".yml")):
        hits.append((str(p), p.read_text(encoding="utf-8", errors="ignore")[:2000]))
    except OSError:
      continue
  return hits


class RepositoryRetriever:
  name = "repository"

  def retrieve(self, queries: list[str], workspace: str) -> list[RetrieveHit]:
    hits: list[RetrieveHit] = []
    qset = {self._norm(q) for q in queries}
    for path, text in _read_files(workspace, []):
      head = text[:500]
      # 簡易相關性：任一 query term 在文件出現
      tokens = qset
      matched = sum(1 for t in tokens if self._norm(t) and any(w in self._norm(head) for w in [self._norm(t)]))
      if matched or path.endswith((".md", ".toml", ".yaml", ".yml")):
        hits.append(RetrieveHit(
          source=Source(type="repository", uri=path, title=os.path.basename(path)),
          text=text,
        ))
    return hits

  @staticmethod
  def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).lower()


class GitHistoryRetriever:
  name = "git_history"

  def retrieve(self, queries: list[str], workspace: str | None) -> list[RetrieveHit]:
    cwd = workspace if workspace and os.path.isdir(os.path.join(workspace, ".git")) else os.getcwd()
    out: list[RetrieveHit] = []
    for args in (["log", "--oneline", "-20"], ["log", "-p", "-3"]):
      try:
        r = subprocess.run(["git", "-C", cwd, *args],
                           capture_output=True, text=True, timeout=15)
      except (FileNotFoundError, subprocess.TimeoutExpired):
        return out
      if r.returncode == 0 and r.stdout.strip():
        out.append(RetrieveHit(
          source=Source(type="repository", uri=f"git:{' '.join(args)}",
                        title=" ".join(args)),
          text=r.stdout,
        ))
    return out


class DocumentationRetriever:
  """本地 docs + 可選官方 docs（HTTP）。"""
  name = "documentation"

  def retrieve(self, queries: list[str], workspace: str) -> list[RetrieveHit]:
    out: list[RetrieveHit] = []
    for path, text in _read_files(workspace, []):
      base = os.path.basename(path)
      if base in {"README.md", "CHANGELOG.md", "docs"} or path.lower().endswith(".md"):
        out.append(RetrieveHit(source=Source(type="official", uri=path, title=base), text=text))
    out.extend(self._fetch_official_docs(queries))
    return out

  def _fetch_official_docs(self, queries: list[str]) -> list[RetrieveHit]:
    try:
      import httpx  # lazy
      from bs4 import BeautifulSoup  # lazy
    except ImportError:
      return []
    client = httpx.Client(timeout=10, follow_redirects=True)
    out: list[RetrieveHit] = []
    for q in queries[:2]:
      urls = self._official_urls(q)
      for url in urls:
        try:
          r = client.get(url)
          if r.status_code != 200:
            continue
          soup = BeautifulSoup(r.text, "html.parser")
          main = soup.find("main") or soup.find("article") or soup.body
          text = (main.get_text(" ", strip=True) if main else soup.get_text(" ", strip=True))[:3000]
          out.append(RetrieveHit(source=Source(type="official", uri=url, title=r.http_request.headers.get("content-type", "")),
                                  text=text, contentType="text/html"))
        except Exception:
          continue
    client.close()
    return out

  @staticmethod
  def _official_urls(query: str) -> list[str]:
    q = re.sub(r"\s+", " ", query).strip()
    if "kubernetes" in q:
      return ["https://kubernetes.io/docs/home/"]
    if "docker" in q:
      return ["https://docs.docker.com/"]
    return []


class WebRetriever:
  """general web：最後手段，僅 HTTP fetch。"""
  name = "web"

  def retrieve(self, queries: list[str], workspace: str) -> list[RetrieveHit]:
    try:
      import httpx
      from bs4 import BeautifulSoup
    except ImportError:
      return []
    client = httpx.Client(timeout=10, follow_redirects=True)
    out: list[RetrieveHit] = []
    for q in queries[:3]:
      for url in self._search_urls(q):
        try:
          r = client.get(url)
          if r.status_code == 200:
            soup = BeautifulSoup(r.text, "html.parser")
            text = (soup.body.get_text(" ", strip=True) if soup.body else "")[:3000]
            out.append(RetrieveHit(source=Source(type="web", uri=url, title=r.url.path),
                                   text=text, contentType="text/html"))
        except Exception:
          continue
      if len(out) >= 3:
        break
    client.close()
    return out

  @staticmethod
  def _search_urls(query: str) -> list[str]:
    return []


ALL_RETRIEVERS = [RepositoryRetriever(), GitHistoryRetriever(), DocumentationRetriever(), WebRetriever()]


# ---- Evidence extraction / normalization ----

CLAUSE_RE = re.compile(r"(?:^|\.\s+)([A-Z][^\n.]{6,200}\.)", re.MULTILINE)


def _split_claims(text: str) -> list[str]:
  if not text:
    return []
  # 依句號/換行切分，取 10–300 字的陳述
  sents = re.split(r"[。\n]+|\.\s+", text)
  claims = [s.strip() for s in sents if 10 <= len(s.strip()) <= 300]
  return claims[:20]


def extract_claims(hit: RetrieveHit) -> list[str]:
  return _split_claims(hit.text)


def to_evidence(hit: RetrieveHit, claim: str, confidence: float = 1.0, relevance: float = 1.0) -> Evidence:
  return Evidence(
    id=f"{hit.source.type}:{_hash(claim)}".replace(":", "-"),
    claim=claim,
    source=Source(type=hit.source.type, uri=hit.source.uri, title=hit.source.title, publisher=hit.source.publisher),
    version=hit.version,
    confidence=confidence,
    relevance=relevance,
    retrievedAt=_now(),
    contentHash=_hash(claim),
  )
