"""User repository backed by SQLAlchemy."""
from sqlalchemy import create_engine, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50))


engine = create_engine("sqlite:///:memory:")
Session = sessionmaker(bind=engine)
Base.metadata.create_all(engine)


def find_by_name(name: str) -> list[User]:
    """Return users whose name matches exactly.

    TODO: implement using SQLAlchemy 2.0 style (select() + where).
    """
    raise NotImplementedError
