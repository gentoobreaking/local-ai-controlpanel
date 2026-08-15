import pandas as pd
from src.frame import count_rows

def test_count_rows():
    data = [{"a": 1}, {"a": 2}, {"a": 3}]
    assert count_rows(data) == 3
    assert count_rows([]) == 0
