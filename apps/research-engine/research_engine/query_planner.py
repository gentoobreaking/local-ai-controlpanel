# -*- coding: utf-8 -*-
"""Query Planner（spec §12）：由 task request + risk + policy 產生查詢。

deterministic：不依 LLM 決定要查什麼。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Query:
  text: str
  sourcePref: tuple[str, ...] = ("repository", "git_history", "documentation", "web")
  keywords: tuple[str, ...] = ()


@dataclass
class QueryPlan:
  queries: list[Query]
  risk: str | None
  researchReasons: list[str]


# risk / reason → 關鍵詞啟發式（保守、可擴充）
REASON_KEYWORDS: dict[str, tuple[str, ...]] = {
  "unknown_dependency": ("dependency", "package", "module"),
  "version_sensitive": ("version", "v1", "v2", "api version"),
  "external_api": ("api", "endpoint", "sdk", "client"),
  "unfamiliar_framework": ("framework", "library"),
  "unfamiliar_repository": ("repo", "pattern", "convention"),
  "external_specification": ("spec", "rfc", "protocol", "standard"),
  "security_sensitive": ("auth", "token", "secret", "security", "permission"),
  "low_confidence": ("best practice", "recommended", "correct way"),
}


def _extract_keywords(request: str) -> list[str]:
  low = request.lower()
  import re
  words = re.findall(r"[a-z0-9_]+", low)
  out: list[str] = []
  seen: set[str] = set()
  for w in words:
    if len(w) <= 2 or w in seen:
      continue
    seen.add(w)
    out.append(w)
  return out


def plan_query(request: str, risk: str | None, reasons: list[str]) -> QueryPlan:
  kw = _extract_keywords(request)
  queries: list[Query] = []
  seen: set[str] = set()

  # 1. 直接以 request 生成一次查詢（Repository / Git History）
  q1 = f"{request}".strip()
  if q1 and q1 not in seen:
    seen.add(q1)
    queries.append(Query(text=q1, keywords=tuple(kw[:6])))

  # 2. 依 risk reason 補充特定查詢
  for reason in reasons:
    extra = " ".join(REASON_KEYWORDS.get(reason, ())).strip()
    if extra:
      q = f"{request} {extra}".strip()
      if q not in seen:
        seen.add(q)
        queries.append(Query(text=q, keywords=tuple(kw[:6])))

  if not queries:
    queries.append(Query(text=request.strip() or "task", keywords=()))

  return QueryPlan(queries=queries, risk=risk, researchReasons=reasons)
