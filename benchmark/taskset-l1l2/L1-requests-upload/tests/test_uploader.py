"""離線驗證：mock requests.post，斷言正確的 multipart API 用法。"""
from unittest import mock

from src.uploader import upload_file


class FakeResponse:
    status_code = 201


def test_upload_uses_multipart_files_param():
    with mock.patch("src.uploader.requests.post", return_value=FakeResponse()) as mp:
        code = upload_file("http://example.com/upload", "/etc/hostname", timeout=5.0)
    assert code == 201
    kwargs = mp.call_args.kwargs
    assert "files" in kwargs, "must use files= for multipart upload"
    assert kwargs["timeout"] == 5.0


def test_upload_field_named_file():
    """用 data=/json= 傳內容不算正確的檔案上傳。"""
    with mock.patch("src.uploader.requests.post", return_value=FakeResponse()) as mp:
        upload_file("http://example.com/upload", "/etc/hostname")
    sent = mp.call_args.kwargs.get("files")
    assert sent is not None and "file" in sent, 'field must be named "file"'
