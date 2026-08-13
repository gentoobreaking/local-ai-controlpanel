# -*- coding: utf-8 -*-
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research_engine.memory import ProjectMemory


def test_memory_roundtrip(tmp_path):
  mem = ProjectMemory(str(tmp_path / "mem.db"))
  assert mem.get("TASK-1", "lang") is None
  mem.set("TASK-1", "lang", "go")
  assert mem.get("TASK-1", "lang") == "go"
  mem.set("TASK-1", "lang", "rust")  # overwrite
  assert mem.get("TASK-1", "lang") == "rust"


def test_memory_knows_subset(tmp_path):
  mem = ProjectMemory(str(tmp_path / "mem.db"))
  mem.set("TASK-1", "lang", "go")
  mem.set("TASK-1", "framework", "controller-runtime")
  known = mem.knowns("TASK-1", ["lang", "framework", "missing"])
  assert known["lang"] == "go"
  assert known["framework"] == "controller-runtime"
  assert "missing" not in known
