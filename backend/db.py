import json
import os
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker


def default_sqlite_path() -> str:
    """Prefer Railway Volume mount if it exists, otherwise local repo DB."""
    volume_dir = Path(os.getenv("RAILWAY_VOLUME_MOUNT_PATH", "/data"))
    if volume_dir.exists() and volume_dir.is_dir():
        return str(volume_dir / "prices.db")
    return os.path.join(os.path.dirname(__file__), "..", "prices.db")


DB_PATH = os.getenv("DATABASE_PATH", default_sqlite_path())
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DB_PATH}")
LOW_PRICE_REVIEW_THRESHOLD_KZT = float(os.getenv("LOW_PRICE_REVIEW_THRESHOLD_KZT", "1000"))

if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

connect_args = {"check_same_thread": False} if SQLALCHEMY_DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def new_uuid() -> str:
    return str(uuid.uuid4())


class Partner(Base):
    __tablename__ = "partners"

    partner_id = Column(String, primary_key=True, default=new_uuid)
    name = Column(String, nullable=False, index=True, unique=True)
    city = Column(String, nullable=True, index=True)
    address = Column(String, nullable=True)
    bin = Column(String(12), nullable=True, index=True)
    contact_email = Column(String, nullable=True)
    contact_phone = Column(String, nullable=True)
    is_active = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    documents = relationship("PriceDocument", back_populates="partner")
    price_items = relationship("PriceItem", back_populates="partner")


class Service(Base):
    __tablename__ = "services"
    __table_args__ = (
        UniqueConstraint("source_code", name="uq_services_source_code"),
    )

    service_id = Column(String, primary_key=True, default=new_uuid)
    source_code = Column(String, nullable=True, index=True)
    service_name = Column(String, nullable=False, index=True)
    synonyms_json = Column(Text, default="[]")
    category = Column(String, nullable=True, index=True)
    icd_code = Column(String, nullable=True)
    tarificatr_code = Column(String, nullable=True, index=True)
    is_active = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    price_items = relationship("PriceItem", back_populates="service")

    @property
    def synonyms(self) -> list[str]:
        try:
            data = json.loads(self.synonyms_json or "[]")
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def set_synonyms(self, values: Optional[list[str]]) -> None:
        self.synonyms_json = json.dumps(values or [], ensure_ascii=False)


class PriceDocument(Base):
    __tablename__ = "price_documents"

    doc_id = Column(String, primary_key=True, default=new_uuid)
    partner_id = Column(String, ForeignKey("partners.partner_id"), nullable=False, index=True)
    file_name = Column(String, nullable=False)
    file_format = Column(String, nullable=False, index=True)
    effective_date = Column(Date, default=date.today, index=True)
    parsed_at = Column(DateTime, default=datetime.utcnow)
    parse_status = Column(String, default="pending", index=True)  # pending / processing / done / error / needs_review
    parse_log = Column(Text, nullable=True)
    raw_content = Column(Text, nullable=True)
    stored_path = Column(String, nullable=True)

    partner = relationship("Partner", back_populates="documents")
    price_items = relationship("PriceItem", back_populates="document")


class PriceItem(Base):
    __tablename__ = "price_items"

    item_id = Column(String, primary_key=True, default=new_uuid)
    doc_id = Column(String, ForeignKey("price_documents.doc_id"), nullable=False, index=True)
    partner_id = Column(String, ForeignKey("partners.partner_id"), nullable=False, index=True)
    service_id = Column(String, ForeignKey("services.service_id"), nullable=True, index=True)

    service_name_raw = Column(String, nullable=False, index=True)
    service_code_source = Column(String, nullable=True, index=True)
    normalized_name = Column(String, nullable=True, index=True)
    match_confidence = Column(Float, default=0)
    match_method = Column(String, nullable=True)

    price_resident_kzt = Column(Float, nullable=True)
    price_nonresident_kzt = Column(Float, nullable=True)
    price_original = Column(Float, nullable=True)
    currency_original = Column(String, default="KZT")

    is_verified = Column(Boolean, default=False, index=True)
    needs_review = Column(Boolean, default=False, index=True)
    verification_note = Column(String, nullable=True)
    effective_date = Column(Date, default=date.today, index=True)
    is_active = Column(Boolean, default=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    document = relationship("PriceDocument", back_populates="price_items")
    partner = relationship("Partner", back_populates="price_items")
    service = relationship("Service", back_populates="price_items")


def _append_note(current: str | None, note: str) -> str:
    current = (current or "").strip()
    if not current:
        return note
    if note in current:
        return current
    return f"{current}; {note}"


@event.listens_for(PriceItem, "before_insert")
@event.listens_for(PriceItem, "before_update")
def flag_low_price_for_review(mapper, connection, target: PriceItem) -> None:
    """Generic data-quality guard: suspiciously low medical prices go to review.

    We do not delete them because some cheap lab/service rows can be real.
    We only mark them for operator review.
    """
    price = target.price_resident_kzt
    if target.is_verified:
        return
    if price is not None and 0 < float(price) < LOW_PRICE_REVIEW_THRESHOLD_KZT:
        target.needs_review = True
        target.verification_note = _append_note(
            target.verification_note,
            f"Подозрительно низкая цена < {int(LOW_PRICE_REVIEW_THRESHOLD_KZT)} ₸",
        )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_or_create_partner(db, name: str, city: str | None = None) -> Partner:
    clean_name = (name or "Анонимный тест").strip() or "Анонимный тест"
    partner = db.query(Partner).filter(Partner.name == clean_name).first()
    if partner:
        if city and not partner.city:
            partner.city = city
        partner.updated_at = datetime.utcnow()
        return partner

    partner = Partner(name=clean_name, city=city)
    db.add(partner)
    db.flush()
    return partner


# Legacy table kept so old /api/prices code does not break during direct main updates.
# The new MVP flow uses Partner/Service/PriceDocument/PriceItem.
class ServicePrice(Base):
    __tablename__ = "service_prices"

    id = Column(String, primary_key=True, default=new_uuid)
    clinic_name = Column(String, index=True)
    service_code = Column(String, nullable=True)
    original_name = Column(String)
    standardized_name = Column(String, index=True)
    price = Column(Float)
    category = Column(String, nullable=True, index=True)
    confidence = Column(Float, default=100)


Base.metadata.create_all(bind=engine)
