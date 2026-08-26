from src.strutil import reverse_words


def test_reverse_words():
    assert reverse_words("hello world") == "world hello"


def test_single_word():
    assert reverse_words("hello") == "hello"
