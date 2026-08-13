# -*- coding: utf-8 -*-
"""Shared fixtures for research-engine tests."""
from __future__ import annotations
import os
import subprocess
import tempfile
from pathlib import Path
import pytest


@pytest.fixture
def workspace(tmp_path) -> str:
  """一個可用的 workspace：README + package.json + git repo。"""
  d = tmp_path / "workspace"
  d.mkdir()
  (d / "README.md").write_text("Example controller using controller-runtime. " * 50, encoding="utf-8")
  (d / "package.json").write_text('{"name":"example","scripts":{"test":"node -e 0"},"dependencies":{"react":"1.0"}}', encoding="utf-8")
  subprocess.run(["git", "init", "-q"], cwd=str(d), check=True)
  subprocess.run(["git", "-C", str(d), "add", "."], check=True)
  subprocess.run(["git", "-C", str(d), "-c", "user.email=t@t.c", "-c", "user.name=t", "commit", "-qm", "init"], check=True)
  return str(d)
