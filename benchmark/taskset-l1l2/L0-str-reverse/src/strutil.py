"""String utility functions."""

def reverse_words(text: str) -> str:
    """Reverse the order of words in the given text."""
    words = text.split()
    reversed_words = words[::-1]
    return ' '.join(reversed_words)
