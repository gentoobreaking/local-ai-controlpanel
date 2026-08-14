from src.report import render

def test_render_contains_text():
    out = render("hello rich")
    assert "hello rich" in out
