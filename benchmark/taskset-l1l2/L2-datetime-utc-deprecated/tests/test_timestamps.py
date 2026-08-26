"""驗證：timezone-aware 取代 deprecated naive API，且行為等價。"""
from datetime import datetime, timezone
import warnings

from src.timestamps import now_utc_naive, ts_from_epoch


def test_now_is_timezone_aware_utc():
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)  # 棄用警告 = 失敗
        dt = now_utc_naive()
    assert dt.tzinfo is not None and dt.tzinfo.utcoffset(dt).total_seconds() == 0


def test_ts_from_epoch_value_matches():
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        dt = ts_from_epoch(0)
    # epoch 0 = 1970-01-01T00:00:00Z
    assert dt.year == 1970 and dt.month == 1 and dt.day == 1
    assert dt.hour == 0 and dt.minute == 0 and dt.second == 0
    assert dt.tzinfo is not None
