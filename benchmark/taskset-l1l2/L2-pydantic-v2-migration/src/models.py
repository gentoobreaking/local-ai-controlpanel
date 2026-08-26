"""User models — written for pydantic v1, must run on pydantic v2."""
from pydantic import BaseModel, validator


class SignupForm(BaseModel):
    email: str
    password: str
    age: int

    @validator("email")
    def email_must_contain_at(cls, v):
        if "@" not in v:
            raise ValueError("invalid email")
        return v.lower()

    @validator("age")
    def age_must_be_adult(cls, v):
        if v < 18:
            raise ValueError("must be 18+")
        return v


class UserOut(BaseModel):
    email: str
    age: int

    class Config:
        orm_mode = True
