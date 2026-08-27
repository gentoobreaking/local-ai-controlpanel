import datetime
import pytz


def now_utc_naive():
    """Return the current UTC time as a naive datetime object."""
    return datetime.datetime.now(pytz.utc)

def ts_from_epoch(epoch):
    """Return the datetime object from the given epoch timestamp."""
    return datetime.datetime.fromtimestamp(epoch, pytz.utc)
