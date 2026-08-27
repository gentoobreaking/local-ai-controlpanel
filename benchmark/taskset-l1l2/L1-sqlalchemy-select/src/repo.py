from sqlalchemy.orm import Session
from sqlalchemy import select

def find_by_name(session: Session, name: str) -> MyModel:
    return session.execute(select(MyModel).where(MyModel.name == name)).scalar_one_or_none()
