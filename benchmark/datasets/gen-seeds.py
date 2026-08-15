#!/usr/bin/env python3
"""Generate T024 Phase-1 Python seed datasets (10 Python of the 50, §35).

Each seed repo = stub `src/*.py` (docstring only) + immutable ground-truth
`tests/test_*.py` (readonly in benchmark). Reused by benchmark-runner.
"""
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATASETS = {
    "py-requests": {
        "mod": "api_client", "lib": "requests",
        "impl": "import requests\n\ndef get_status_code(url):\n    response = requests.get(url)\n    return response.status_code\n",
        "test": '''import pytest
import requests

def test_get_status_code_returns_int(monkeypatch):
    captured = {}
    class R:
        status_code = 200
    def fake_get(url, **kw):
        captured["url"] = url
        return R()
    monkeypatch.setattr(requests, "get", fake_get)
    from src.api_client import get_status_code
    assert isinstance(get_status_code("https://example.com"), int)
    assert get_status_code("https://example.com") == 200
    assert captured["url"] == "https://example.com"
''',
    },
    "py-httpx": {
        "mod": "client", "lib": "httpx",
        "impl": "import httpx\n\ndef get_status_code(url):\n    response = httpx.get(url)\n    return response.status_code\n",
        "test": '''import pytest
import httpx

def test_get_status_code(monkeypatch):
    class R:
        status_code = 200
    def fake_get(url, **kw):
        return R()
    monkeypatch.setattr(httpx, "get", fake_get)
    from src.client import get_status_code
    assert get_status_code("https://example.com") == 200
''',
    },
    "py-yaml": {
        "mod": "config", "lib": "yaml",
        "impl": "import yaml\n\ndef load_config(text):\n    return yaml.safe_load(text)\n",
        "test": '''import yaml
from src.config import load_config

def test_load_config_parse():
    data = load_config("key: value\\nlist:\\n  - 1\\n  - 2")
    assert data["key"] == "value"
    assert data["list"] == [1, 2]
''',
    },
    "py-bs4": {
        "mod": "scraper", "lib": "bs4",
        "impl": "from bs4 import BeautifulSoup\n\ndef first_title(html):\n    return BeautifulSoup(html, 'html.parser').title.string.strip()\n",
        "test": '''from src.scraper import first_title

def test_first_title():
    html = "<html><head><title>hi</title></head><body></body></html>"
    assert first_title(html) == "hi"
''',
    },
    "py-rich": {
        "mod": "report", "lib": "rich",
        "impl": "from rich.console import Console\n\ndef render(text):\n    console = Console(record=True, width=80)\n    console.print(text)\n    return console.export_text()\n",
        "test": '''from src.report import render

def test_render_contains_text():
    out = render("hello rich")
    assert "hello rich" in out
''',
    },
    "py-click": {
        "mod": "cli", "lib": "click",
        "impl": "import click\n\n@click.command()\n@click.argument(\"name\")\ndef main(name):\n    click.echo(f'hi {name}')\n",
        "test": '''import click
from click.testing import CliRunner
from src.cli import main

def test_main_says_hi():
    res = CliRunner().invoke(main, ["world"])
    assert res.exit_code == 0
    assert "hi world" in res.output
''',
    },
    "py-pandas": {
        "mod": "frame", "lib": "pandas",
        "impl": "import pandas as pd\n\ndef count_rows(rows):\n    return len(pd.DataFrame(rows))\n",
        "test": '''import pandas as pd
from src.frame import count_rows

def test_count_rows():
    data = [{"a": 1}, {"a": 2}, {"a": 3}]
    assert count_rows(data) == 3
    assert count_rows([]) == 0
''',
    },
    "py-sqlalchemy": {
        "mod": "orm", "lib": "sqlalchemy",
        "impl": "from sqlalchemy.orm import Session\nfrom sqlalchemy import select\n\ndef insert_user(session: Session, name: str):\n    from src.models import User\n    user = User(name=name)\n    session.add(user)\n    session.commit()\n    return session.scalar(select(User).where(User.name == name))\n",
        "test": '''from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.orm import Session, declarative_base

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)

def test_insert_user():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = insert_user(session, "alice")
        assert user.name == "alice"
        user2 = insert_user(session, "bob")
        assert user2.name == "bob"
''',
    },
    "py-fastapi": {
        "mod": "app", "lib": "fastapi",
        "impl": "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get(\"/health\")\ndef health():\n    return {\"status\": \"ok\"}\n",
        "test": '''from fastapi.testclient import TestClient
from src.app import app

def test_health():
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
''',
    },
    "py-redis": {
        "mod": "cache", "lib": "redis",
        "impl": "import redis\n\ndef get_set(client: redis.Redis, key: str, val: str):\n    client.set(key, val)\n    return client.get(key)\n",
        "test": '''import redis
from unittest.mock import MagicMock
from src.cache import get_set

def test_get_set():
    mock_client = MagicMock(spec=redis.Redis)
    mock_client.get.return_value = b"value"
    assert get_set(mock_client, "key", "value") == b"value"
    mock_client.set.assert_called_once_with("key", "value")
''',
    },
}

for name, spec in DATASETS.items():
    d = ROOT / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "src").mkdir(exist_ok=True)
    (d / "tests").mkdir(exist_ok=True)
    (d / "pyproject.toml").write_text(f'[project]\nname = "{name}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = ["{spec["lib"]}"]\n[project.optional-dependencies]\ndev = ["pytest>=7"]\n[tool.ruff]\nline-length = 100\nselect = ["E9","F"]\n')
    (d / "src" / f"{spec['mod']}.py").write_text('"""Seed stub: ' + spec["lib"] + '. Implement per research."""\n')
    (d / "tests" / f"test_{spec['mod']}.py").write_text(spec["test"])
    (d / "src" / "__init__.py").write_text("")
    (d / "tests" / "__init__.py").write_text("")
    print("wrote", name)
