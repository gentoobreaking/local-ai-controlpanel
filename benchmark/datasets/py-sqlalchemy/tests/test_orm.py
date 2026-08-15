from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.orm import Session, declarative_base

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)

def test_insert_user():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        user = insert_user(session, "alice")
        assert user.name == "alice"
        user2 = insert_user(session, "bob")
        assert user2.name == "bob"
