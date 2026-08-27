"""File upload client."""
import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder

def upload_file(url: str, path: str, timeout: float = 5.0) -> int:
    """Upload `path` to `url` as multipart form field "file".
    Returns the HTTP status code. Raises requests exception on network error.
    Must enforce the given timeout (seconds).
    """
    with open(path, "rb") as f:
        multipart_data = MultipartEncoder(
            fields={"file": (path, f, "application/octet-stream")}
        )
        response = requests.post(url, data=multipart_data, timeout=timeout)
        return response.status_code
