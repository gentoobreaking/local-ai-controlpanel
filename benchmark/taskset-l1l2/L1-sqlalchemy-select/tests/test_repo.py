from src.repo import Session, User, find_by_name


def _seed():
    s = Session()
    s.add_all([User(name="alice"), User(name="bob"), User(name="alice2")])
    s.commit()
    s.close()


def test_find_exact_match():
    _seed()
    users = find_by_name("alice")
    assert [u.name for u in users] == ["alice"]


def test_no_result():
    _seed()
    assert find_by_name("nobody") == []
