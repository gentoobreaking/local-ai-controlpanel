"""Demo module: uses `requests` external library.

Task: implement `get_status_code(url)` that performs a GET request and
returns the HTTP status code. The current `requests` API must be researched
(e.g. `requests.get()` returns a `Response` object with `.status_code`).
"""

import requests

def get_status_code(url):
    response = requests.get(url)
    return response.status_code

