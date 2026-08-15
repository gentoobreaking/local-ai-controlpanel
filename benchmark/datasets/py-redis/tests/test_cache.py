import redis
from unittest.mock import MagicMock
from src.cache import get_set

def test_get_set():
    mock_client = MagicMock(spec=redis.Redis)
    mock_client.get.return_value = b"value"
    assert get_set(mock_client, "key", "value") == b"value"
    mock_client.set.assert_called_once_with("key", "value")
