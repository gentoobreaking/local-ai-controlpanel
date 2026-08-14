import yaml
from src.config import load_config

def test_load_config_parse():
    data = load_config("key: value\nlist:\n  - 1\n  - 2")
    assert data["key"] == "value"
    assert data["list"] == [1, 2]
