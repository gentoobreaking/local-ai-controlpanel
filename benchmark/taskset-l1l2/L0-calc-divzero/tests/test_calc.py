from src.calc import divide
import pytest


def test_divide_ok():
    assert divide(10, 2) == 5


def test_divide_zero_raises_value_error():
    with pytest.raises(ValueError):
        divide(1, 0)


def test_divide_negative_ok():
    assert divide(-6, 3) == -2
