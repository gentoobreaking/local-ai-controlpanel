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
}

for name, spec in DATASETS.items():
    d = ROOT / name
    (d / "pyproject.toml").write_text(f'[project]\nname = "{name}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = ["{spec["lib"]}"]\n[project.optional-dependencies]\ndev = ["pytest>=7"]\n[tool.ruff]\nline-length = 100\nselect = ["E9","F"]\n')
    (d / "src" / f"{spec['mod']}.py").write_text('"""Seed stub: ' + spec["lib"] + '. Implement per research."""\n')
    (d / "tests" / f"test_{spec['mod']}.py").write_text(spec["test"])
    (d / "src" / "__init__.py").write_text("")
    (d / "tests" / "__init__.py").write_text("")
    print("wrote", name)
