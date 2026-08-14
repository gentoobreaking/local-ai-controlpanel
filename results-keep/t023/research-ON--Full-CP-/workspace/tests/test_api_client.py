"""Tests for api_client.get_status_code.

These tests exercise the external library (`requests`) API:
- requests.get(url) returns a Response
- Response.status_code is an int
"""
import pytest

from src.api_client import get_status_code


class FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code


@pytest.fixture
def fake_get(monkeypatch):
    """Replace requests.get with a fake that records the call."""
    import requests

    calls = {}

    def fake_get(url, **kwargs):
        calls["url"] = url
        calls["kwargs"] = kwargs
        return FakeResponse(200)

    monkeypatch.setattr(requests, "get", fake_get)
    return calls


def test_get_status_code_returns_int(fake_get):
    assert isinstance(get_status_code("https://example.com"), int)


def test_get_status_code_passes_url(fake_get):
    result = get_status_code("https://example.com")
    assert result == 200
    assert fake_get["url"] == "https://example.com"
