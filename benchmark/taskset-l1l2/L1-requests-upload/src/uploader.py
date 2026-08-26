"""File upload client."""
import requests


def upload_file(url: str, path: str, timeout: float = 5.0) -> int:
    """Upload `path` to `url` as multipart form field "file".

    Returns the HTTP status code. Raises requests exception on network error.
    Must enforce the given timeout (seconds).
    """
    raise NotImplementedError
