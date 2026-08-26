"""Timestamp helpers — uses deprecated APIs on Python 3.12+. Must be modernized."""
from datetime import datetime, timezone


def now_utc_naive() -> datetime:
    """Return current UTC time as a NAIVE datetime (deprecated pattern)."""
    return datetime.utcnow()


def ts_from_epoch(secs: float) -> datetime:
    """Convert epoch seconds to a NAIVE UTC datetime (deprecated pattern)."""
    return datetime.utcfromtimestamp(secs)
