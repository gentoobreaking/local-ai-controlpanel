import pytest
import httpx

def test_get_status_code(monkeypatch):
    class R:
        status_code = 200
    def fake_get(url, **kw):
        return R()
    monkeypatch.setattr(httpx, "get", fake_get)
    from src.client import get_status_code
    assert get_status_code("https://example.com") == 200
