class FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code

from src.api_client import get_status_code
