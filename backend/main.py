import os
import re
import sys
import threading
import uuid
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import List, Optional

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ai_processor import parse_price_list_with_ai
from db import (
    Base,
    Partner,
    PriceDocument,
    PriceItem,
    Service,
    engine,
    get_db,
    get_or_create_partner,
    SessionLocal,
)
from extractor import detect_file_format, extract_text, iter_input_files
from normalizer import import_service_catalog, match_service

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="MedArchive Price Parser API",
    description="MVP: parsing partner clinic price archives, service catalog matching, verification queue and search.",
    version="0.5.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/frontend", StaticFiles(directory=frontend_dir), name="frontend")

ROOT_DIR = Path(os.path.dirname(__file__)).parent
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", str(ROOT_DIR / "uploads")))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
BUNDLED_CATALOG_PATH = ROOT_DIR / "data" / "services_catalog.csv"

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


class ManualMatchRequest(BaseModel):
    item_id: str
    service_id: str
    verification_note: Optional[str] = None


class PartnerUpdateRequest(BaseModel):
    name: str
    city: Optional[str] = None
    address: Optional[str] = None
    bin: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None


def safe_filename(value: str) -> str:
    value = re.sub(r"[^a-zA-Zа-яА-Я0-9._-]+", "_", value or "file")
    return value[:120]


def infer_partner_name(upload_filename: str, inner_filename: str, fallback: str) -> str:
    fallback = (fallback or "Анонимный тест").strip() or "Анонимный тест"
    if not (upload_filename or "").lower().endswith(".zip"):
        return fallback

    normalized_path = (inner_filename or "").replace("\\", "/")
    parts = [p.strip() for p in normalized_path.split("/") if p.strip() and p.strip() != "."]
    if not parts:
        return fallback

    candidate = parts[0] if len(parts) > 1 else PurePosixPath(parts[0]).stem
    candidate = re.sub(r"[_-]+", " ", candidate)
    candidate = re.sub(
        r"(?i)\b(price|prices|pricelist|прайс|прайсы|прейскурант|услуги|services|лист|file|файл|202\d|20\d\d)\b",
        " ",
        candidate,
    )
    candidate = re.sub(r"\s+", " ", candidate).strip(" ._-–—")
    return candidate or fallback


def to_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace("\u00a0", " ").strip()
    if not text or text.lower() in {"nan", "none", "null", "-"}:
        return None
    text = re.sub(r"[^0-9,.-]", "", text).replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def item_to_response(item: PriceItem) -> dict:
    service = item.service
    return {
        "item_id": item.item_id,
        "doc_id": item.doc_id,
        "partner_id": item.partner_id,
        "clinic_name": item.partner.name if item.partner else None,
        "service_id": item.service_id,
        "service_code": item.service_code_source,
        "original_name": item.service_name_raw,
        "standardized_name": service.service_name if service else item.normalized_name,
        "price": item.price_resident_kzt,
        "price_resident_kzt": item.price_resident_kzt,
        "price_nonresident_kzt": item.price_nonresident_kzt,
        "currency": item.currency_original,
        "category": service.category if service else None,
        "confidence": round(item.match_confidence or 0, 2),
        "match_method": item.match_method,
        "needs_review": item.needs_review,
        "is_verified": item.is_verified,
        "note": item.verification_note,
        "effective_date": item.effective_date.isoformat() if item.effective_date else None,
    }


def bootstrap_catalog_if_needed(force: bool = False) -> dict:
    db = SessionLocal()
    try:
        current_count = db.query(Service).count()
        if current_count and not force:
            return {"message": "Справочник уже загружен", "services": current_count, "skipped_bootstrap": True}
        if not BUNDLED_CATALOG_PATH.exists():
            return {"message": "Встроенный справочник не найден", "services": current_count, "skipped_bootstrap": True}
        result = import_service_catalog(db, BUNDLED_CATALOG_PATH.name, BUNDLED_CATALOG_PATH.read_bytes())
        return {"message": "Встроенный справочник загружен", **result, "services": db.query(Service).count()}
    except Exception as exc:
        db.rollback()
        return {"message": "Ошибка загрузки встроенного справочника", "error": str(exc)}
    finally:
        db.close()


def set_job(job_id: str, **kwargs) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(kwargs)


def set_job_file(job_id: str, index: int, **kwargs) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        for f in job["documents"]:
            if f["index"] == index:
                f.update(kwargs)
                break
        job["processed_files"] = sum(1 for f in job["documents"] if f["status"] in {"done", "needs_review", "error"})
        job["items_found"] = sum(int(f.get("items") or 0) for f in job["documents"])
        job["needs_review"] = sum(int(f.get("review_items") or 0) for f in job["documents"])
        if all(f["status"] in {"done", "needs_review", "error"} for f in job["documents"]):
            job["status"] = "finished_with_errors" if any(f["status"] == "error" for f in job["documents"]) else "done"
        else:
            job["status"] = "processing"


def process_file_payload(job_id: str, payload: dict, parsed_effective_date: date, groq_api_key: str) -> None:
    db = SessionLocal()
    index = payload["index"]
    inner_filename = payload["inner_filename"]
    contents = payload["contents"]
    partner_name = payload["partner_name"]

    set_job_file(job_id, index, status="processing", error=None)
    try:
        if db.query(Service).count() == 0:
            bootstrap_catalog_if_needed(force=False)

        partner = get_or_create_partner(db, partner_name)
        doc = PriceDocument(
            partner_id=partner.partner_id,
            file_name=inner_filename,
            file_format=detect_file_format(inner_filename, contents),
            effective_date=parsed_effective_date,
            parse_status="processing",
        )
        db.add(doc)
        db.flush()

        stored_path = UPLOAD_DIR / f"{doc.doc_id}_{safe_filename(inner_filename)}"
        stored_path.write_bytes(contents)
        doc.stored_path = str(stored_path)

        raw_text = extract_text(inner_filename, contents)
        doc.raw_content = raw_text[:200_000]
        if not raw_text.strip():
            doc.parse_status = "error"
            doc.parse_log = "Документ не содержит распознаваемого текста. Вероятно, нужен OCR."
            db.commit()
            set_job_file(job_id, index, status="error", error=doc.parse_log, items=0, review_items=0)
            return

        parsed_data = parse_price_list_with_ai(raw_text, groq_api_key)
        if not parsed_data:
            doc.parse_status = "error"
            doc.parse_log = "AI не вернул структурированные позиции."
            db.commit()
            set_job_file(job_id, index, status="error", error=doc.parse_log, items=0, review_items=0)
            return

        created_count = 0
        review_count = 0
        response_items = []

        for raw_item in parsed_data:
            raw_name = (
                raw_item.get("original_name")
                or raw_item.get("service_name_raw")
                or raw_item.get("standardized_name")
                or ""
            ).strip()
            if not raw_name:
                continue

            service_code = raw_item.get("service_code") or raw_item.get("code")
            normalized_name = raw_item.get("standardized_name") or raw_name
            category_hint = raw_item.get("category")
            ai_confidence = to_float(raw_item.get("confidence")) or 0

            price_resident = to_float(raw_item.get("price_resident_kzt"))
            price_nonresident = to_float(raw_item.get("price_nonresident_kzt"))
            price_main = to_float(raw_item.get("price"))
            if price_resident is None:
                price_resident = price_main
            if price_main is None:
                price_main = price_resident

            currency = (raw_item.get("currency") or raw_item.get("currency_original") or "KZT").upper()
            matched = match_service(db, normalized_name or raw_name, category_hint, service_code)

            confidence = matched.confidence
            if ai_confidence:
                confidence = min(confidence or ai_confidence, ai_confidence)

            validation_notes = []
            needs_review = matched.needs_review
            if price_resident is None or price_resident <= 0:
                needs_review = True
                validation_notes.append("Цена не распознана или <= 0")
            if price_nonresident is not None and price_resident is not None and price_nonresident < price_resident:
                needs_review = True
                validation_notes.append("Цена нерезидента ниже цены резидента")
            if parsed_effective_date > date.today():
                needs_review = True
                validation_notes.append("Дата прайса в будущем")

            item = PriceItem(
                doc_id=doc.doc_id,
                partner_id=partner.partner_id,
                service_id=matched.service.service_id if matched.service else None,
                service_name_raw=raw_name,
                service_code_source=str(service_code).strip() if service_code else None,
                normalized_name=normalized_name,
                match_confidence=confidence,
                match_method=matched.method,
                price_resident_kzt=price_resident,
                price_nonresident_kzt=price_nonresident,
                price_original=price_main,
                currency_original=currency,
                needs_review=needs_review,
                verification_note="; ".join(validation_notes) if validation_notes else None,
                effective_date=parsed_effective_date,
            )
            db.add(item)
            db.flush()
            response_items.append(item_to_response(item))
            created_count += 1
            review_count += 1 if needs_review else 0

        doc.parse_status = "needs_review" if review_count else "done"
        doc.parse_log = f"Создано позиций: {created_count}; на ревью: {review_count}"
        db.commit()

        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if job:
                job["data"].extend(response_items[:50])
        set_job_file(job_id, index, status=doc.parse_status, items=created_count, review_items=review_count, error=None)

    except Exception as exc:
        db.rollback()
        set_job_file(job_id, index, status="error", error=str(exc), items=0, review_items=0)
    finally:
        db.close()


def process_upload_job(job_id: str, file_payloads: list[dict], effective_date_text: str | None, groq_api_key: str) -> None:
    try:
        parsed_effective_date = date.today()
        if effective_date_text:
            parsed_effective_date = datetime.fromisoformat(effective_date_text).date()
        set_job(job_id, status="processing", started_at=datetime.utcnow().isoformat())
        for payload in file_payloads:
            process_file_payload(job_id, payload, parsed_effective_date, groq_api_key)
        with JOBS_LOCK:
            if job_id in JOBS:
                JOBS[job_id]["finished_at"] = datetime.utcnow().isoformat()
    except Exception as exc:
        set_job(job_id, status="error", error=str(exc), finished_at=datetime.utcnow().isoformat())


@app.on_event("startup")
def startup_bootstrap_catalog():
    bootstrap_catalog_if_needed(force=False)


@app.get("/", response_class=HTMLResponse)
async def read_index():
    index_path = os.path.join(frontend_dir, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>MedArchive Price Parser API</h1><p>Open /docs for Swagger.</p>"


@app.get("/api/health")
async def health(db: Session = Depends(get_db)):
    return {"ok": True, "services": db.query(Service).count(), "documents": db.query(PriceDocument).count()}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job не найден. Возможно, сервер перезапустился.")
        return job


@app.post("/api/upload-async")
async def upload_file_async(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    clinic_name: str = Form("Анонимный тест"),
    effective_date: Optional[str] = Form(None),
):
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY не настроен.")

    if effective_date:
        try:
            datetime.fromisoformat(effective_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="effective_date должен быть YYYY-MM-DD")

    file_payloads: list[dict] = []
    documents = []
    partners_seen = set()
    index = 0

    for upload in files:
        original_bytes = await upload.read()
        for inner_filename, contents in iter_input_files(upload.filename, original_bytes):
            partner_name = infer_partner_name(upload.filename, inner_filename, clinic_name)
            partners_seen.add(partner_name)
            file_payloads.append({
                "index": index,
                "upload_filename": upload.filename,
                "inner_filename": inner_filename,
                "partner_name": partner_name,
                "contents": contents,
            })
            documents.append({
                "index": index,
                "clinic_name": partner_name,
                "file_name": inner_filename,
                "status": "pending",
                "items": 0,
                "review_items": 0,
                "error": None,
            })
            index += 1

    if not file_payloads:
        raise HTTPException(status_code=400, detail="В ZIP не найдено поддерживаемых файлов: pdf/xlsx/xls/csv/docx/txt")

    job_id = str(uuid.uuid4())
    with JOBS_LOCK:
        JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": datetime.utcnow().isoformat(),
            "started_at": None,
            "finished_at": None,
            "clinic_name": clinic_name,
            "partners_detected": sorted(partners_seen),
            "total_files": len(documents),
            "processed_files": 0,
            "items_found": 0,
            "needs_review": 0,
            "documents": documents,
            "data": [],
        }

    background_tasks.add_task(process_upload_job, job_id, file_payloads, effective_date, groq_api_key)
    return JOBS[job_id]


@app.post("/api/catalog/bootstrap")
async def bootstrap_catalog(force: bool = False):
    result = bootstrap_catalog_if_needed(force=force)
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result)
    return result


@app.post("/api/catalog/upload")
async def upload_catalog(file: UploadFile = File(...), db: Session = Depends(get_db)):
    contents = await file.read()
    try:
        result = import_service_catalog(db, file.filename, contents)
        return {"message": "Справочник услуг загружен", **result, "services": db.query(Service).count()}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Ошибка импорта справочника: {exc}")


@app.post("/api/partners")
async def upsert_partner(payload: PartnerUpdateRequest, db: Session = Depends(get_db)):
    partner = get_or_create_partner(db, payload.name, city=payload.city)
    partner.address = payload.address
    partner.bin = payload.bin
    partner.contact_email = payload.contact_email
    partner.contact_phone = payload.contact_phone
    db.commit()
    db.refresh(partner)
    return partner


@app.post("/api/upload")
async def upload_file(
    files: List[UploadFile] = File(...),
    clinic_name: str = Form("Анонимный тест"),
    effective_date: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    # Backward-compatible endpoint: process synchronously by creating a temporary job and waiting.
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY не настроен.")

    parsed_effective_date = date.today()
    if effective_date:
        try:
            parsed_effective_date = datetime.fromisoformat(effective_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="effective_date должен быть YYYY-MM-DD")

    file_payloads = []
    documents = []
    partners_seen = set()
    index = 0
    for upload in files:
        original_bytes = await upload.read()
        for inner_filename, contents in iter_input_files(upload.filename, original_bytes):
            partner_name = infer_partner_name(upload.filename, inner_filename, clinic_name)
            partners_seen.add(partner_name)
            file_payloads.append({"index": index, "upload_filename": upload.filename, "inner_filename": inner_filename, "partner_name": partner_name, "contents": contents})
            documents.append({"index": index, "clinic_name": partner_name, "file_name": inner_filename, "status": "pending", "items": 0, "review_items": 0, "error": None})
            index += 1

    job_id = str(uuid.uuid4())
    with JOBS_LOCK:
        JOBS[job_id] = {"job_id": job_id, "status": "processing", "clinic_name": clinic_name, "partners_detected": sorted(partners_seen), "total_files": len(documents), "processed_files": 0, "items_found": 0, "needs_review": 0, "documents": documents, "data": []}
    for payload in file_payloads:
        process_file_payload(job_id, payload, parsed_effective_date, groq_api_key)
    with JOBS_LOCK:
        job = JOBS[job_id]
        return {"message": "Успешно обработано!" if job["items_found"] else "Файлы обработаны, но позиции не извлечены.", **job}


@app.get("/api/services")
async def list_services(category: str | None = None, q: str | None = None, db: Session = Depends(get_db)):
    query = db.query(Service).filter(Service.is_active == True)  # noqa: E712
    if category:
        query = query.filter(Service.category.ilike(f"%{category}%"))
    if q:
        query = query.filter(Service.service_name.ilike(f"%{q}%"))
    return query.order_by(Service.category, Service.service_name).limit(500).all()


@app.get("/api/services/{service_id}/partners")
async def service_partners(service_id: str, db: Session = Depends(get_db)):
    items = db.query(PriceItem).filter(PriceItem.service_id == service_id, PriceItem.is_active == True).order_by(PriceItem.price_resident_kzt.asc()).all()  # noqa: E712
    return [item_to_response(item) for item in items]


@app.get("/api/partners")
async def list_partners(city: str | None = None, is_active: bool | None = None, db: Session = Depends(get_db)):
    query = db.query(Partner)
    if city:
        query = query.filter(Partner.city.ilike(f"%{city}%"))
    if is_active is not None:
        query = query.filter(Partner.is_active == is_active)
    return query.order_by(Partner.name).all()


@app.get("/api/partners/{partner_id}/services")
async def partner_services(partner_id: str, db: Session = Depends(get_db)):
    items = db.query(PriceItem).filter(PriceItem.partner_id == partner_id, PriceItem.is_active == True).order_by(PriceItem.service_name_raw).all()  # noqa: E712
    return [item_to_response(item) for item in items]


@app.get("/api/search")
async def search(q: str, db: Session = Depends(get_db)):
    if not q.strip():
        return {"services": [], "partners": [], "prices": []}
    pattern = f"%{q.strip()}%"
    services = db.query(Service).filter(Service.service_name.ilike(pattern)).limit(50).all()
    partners = db.query(Partner).filter(Partner.name.ilike(pattern)).limit(50).all()
    prices = db.query(PriceItem).filter(or_(PriceItem.service_name_raw.ilike(pattern), PriceItem.normalized_name.ilike(pattern))).limit(100).all()
    return {"services": services, "partners": partners, "prices": [item_to_response(item) for item in prices]}


@app.get("/api/unmatched")
async def unmatched(db: Session = Depends(get_db)):
    items = db.query(PriceItem).filter(or_(PriceItem.service_id.is_(None), PriceItem.needs_review == True)).order_by(PriceItem.created_at.desc()).limit(500).all()  # noqa: E712
    return [item_to_response(item) for item in items]


@app.post("/api/match")
async def manual_match(payload: ManualMatchRequest, db: Session = Depends(get_db)):
    item = db.query(PriceItem).filter(PriceItem.item_id == payload.item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Позиция прайса не найдена")
    service = db.query(Service).filter(Service.service_id == payload.service_id).first()
    if not service:
        raise HTTPException(status_code=404, detail="Услуга справочника не найдена")

    item.service_id = service.service_id
    item.match_confidence = 100
    item.match_method = "manual"
    item.needs_review = False
    item.is_verified = True
    item.verification_note = payload.verification_note or "Подтверждено оператором"
    db.commit()
    db.refresh(item)
    return item_to_response(item)


@app.get("/api/prices")
async def get_prices(clinic_name: str = None, db: Session = Depends(get_db)):
    query = db.query(PriceItem).join(Partner)
    if clinic_name:
        query = query.filter(Partner.name == clinic_name)
    return [item_to_response(item) for item in query.order_by(PriceItem.created_at.desc()).limit(1000).all()]


@app.get("/api/stats")
async def stats(db: Session = Depends(get_db)):
    total_docs = db.query(PriceDocument).count()
    total_items = db.query(PriceItem).count()
    matched_items = db.query(PriceItem).filter(PriceItem.service_id.isnot(None)).count()
    review_items = db.query(PriceItem).filter(PriceItem.needs_review == True).count()  # noqa: E712
    return {
        "partners": db.query(Partner).count(),
        "services": db.query(Service).count(),
        "documents": total_docs,
        "price_items": total_items,
        "matched_items": matched_items,
        "auto_normalization_percent": round((matched_items / total_items * 100), 2) if total_items else 0,
        "needs_review": review_items,
    }
