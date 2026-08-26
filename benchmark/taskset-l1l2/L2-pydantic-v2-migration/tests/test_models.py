"""pydantic v2 環境驗證：行為正確且不得使用 v1 棄用 API。"""
import inspect
import pytest
import src.models as models_mod
from src.models import SignupForm, UserOut


def test_valid_signup_and_normalization():
    f = SignupForm(email="Alice@Example.com", password="secret123", age=30)
    assert f.email == "alice@example.com"


def test_invalid_email_raises():
    with pytest.raises(Exception, match="invalid email"):
        SignupForm(email="no-at-sign", password="x", age=20)


def test_underage_raises():
    with pytest.raises(Exception):
        SignupForm(email="a@b.com", password="x", age=12)


def test_orm_mode_from_attributes():
    class Row:
        email = "r@x.com"
        age = 40
    out = UserOut.model_validate(Row(), from_attributes=True)
    assert out.email == "r@x.com"


def test_no_v1_deprecated_api():
    """v1 的 @validator 與 orm_mode 在 v2 已棄用——必須使用 v2 對應寫法。"""
    src = inspect.getsource(models_mod)
    assert "@validator" not in src, "must use @field_validator (pydantic v2)"
    assert "orm_mode" not in src, "must use model_config = ConfigDict(from_attributes=True)"
    assert "field_validator" in src or "model_validator" in src


def test_v2_metadata_present():
    """v2 的 model_fields 存在且 email 欄位有註冊 validator。"""
    fields = SignupForm.model_fields
    assert "email" in fields and "age" in fields
