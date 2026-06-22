import os
from sqlalchemy import create_engine, Column, Integer, String, Float
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

# Настройка SQLite
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "prices.db")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# Модель для прайс-листа
class ServicePrice(Base):
    __tablename__ = "service_prices"

    id = Column(Integer, primary_key=True, index=True)
    clinic_name = Column(String, index=True)
    service_code = Column(String, nullable=True)
    original_name = Column(String)
    standardized_name = Column(String, index=True)
    price = Column(Float)
    category = Column(String, nullable=True, index=True)
    confidence = Column(Integer, default=100)

# Создание таблиц
Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
