import click
from click.testing import CliRunner
from src.cli import main

def test_main_says_hi():
    res = CliRunner().invoke(main, ["world"])
    assert res.exit_code == 0
    assert "hi world" in res.output
