from src.scraper import first_title

def test_first_title():
    html = "<html><head><title>hi</title></head><body></body></html>"
    assert first_title(html) == "hi"
