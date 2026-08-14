import pytest
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
