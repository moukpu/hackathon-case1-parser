from contextvars import ContextVar
from pathlib import PurePosixPath
import re

from sqlalchemy import event, text

from backend import main
from db import PriceDocument, PriceItem, SessionLocal, engine

CURRENT_JOB_ID = ContextVar("CURRENT_JOB_ID", default=None)
ORIGINAL_PROCESS_FILE_PAYLOAD = main.process_file_payload


def ensure_job_id_columns() -> None:
    with engine.begin() as conn:
        for table_name in ("price_documents", "price_items"):
            try:
                conn.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN IF NOT EXISTS job_id VARCHAR'))
            except Exception:
                try:
                    conn.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN job_id VARCHAR'))
                except Exception:
                    pass
            try:
                conn.execute(text(f'CREATE INDEX IF NOT EXISTS ix_{table_name}_job_id ON "{table_name}" (job_id)'))
            except Exception:
                pass


def clean_clinic_name_from_file(filename: str, fallback: str = "") -> str:
    path = (filename or "").replace("\\", "/")
    parts = [p.strip() for p in path.split("/") if p.strip() and p.strip() != "."]
    if not parts:
        return (fallback or "Клиника").strip() or "Клиника"
    candidate = parts[0] if len(parts) > 1 else PurePosixPath(parts[0]).stem
    candidate = re.sub(r"[_-]+", " ", candidate)
    candidate = re.sub(
        r"(?i)\b(price|prices|pricelist|прайс|прайсы|прейскурант|услуги|services|лист|file|файл|год|года|year|202\d|20\d\d|pdf|docx|xlsx|xls|csv)\b",
        " ",
        candidate,
    )
    candidate = re.sub(r"\s+", " ", candidate).strip(" ._-–—")
    return candidate or (fallback or "Клиника").strip() or "Клиника"


def infer_partner_name(upload_filename: str, inner_filename: str, fallback: str) -> str:
    fallback_clean = (fallback or "").strip()
    if (upload_filename or "").lower().endswith(".zip"):
        return clean_clinic_name_from_file(inner_filename, fallback_clean)
    return clean_clinic_name_from_file(upload_filename or inner_filename, fallback_clean)


def sync_job_file_from_db(job_id: str, payload: dict) -> None:
    user_id = payload.get("user_id")
    index = payload.get("index")
    inner_filename = payload.get("inner_filename")
    if not user_id or index is None:
        return

    db = SessionLocal()
    try:
        doc = db.execute(
            text(
                "SELECT doc_id, parse_status, parse_log FROM price_documents "
                "WHERE user_id=:user_id AND job_id=:job_id AND file_name=:file_name "
                "ORDER BY parsed_at DESC LIMIT 1"
            ),
            {"user_id": user_id, "job_id": job_id, "file_name": inner_filename},
        ).fetchone()
        if not doc:
            return
        counts = db.execute(
            text(
                "SELECT COUNT(*) AS items, "
                "SUM(CASE WHEN needs_review = TRUE OR service_id IS NULL THEN 1 ELSE 0 END) AS review_items "
                "FROM price_items WHERE user_id=:user_id AND job_id=:job_id AND doc_id=:doc_id"
            ),
            {"user_id": user_id, "job_id": job_id, "doc_id": doc.doc_id},
        ).fetchone()
        items = int(counts.items or 0) if counts else 0
        review_items = int(counts.review_items or 0) if counts and counts.review_items is not None else 0
        status = "needs_review" if review_items else (doc.parse_status or "done")
        if review_items and doc.parse_status != "needs_review":
            db.execute(text("UPDATE price_documents SET parse_status='needs_review' WHERE doc_id=:doc_id"), {"doc_id": doc.doc_id})
            db.commit()

        with main.JOBS_LOCK:
            job = main.JOBS.get(job_id)
            if not job:
                return
            for item in job.get("documents") or []:
                if item.get("index") == index:
                    item["status"] = status
                    item["items"] = items
                    item["review_items"] = review_items
                    item["error"] = None if status != "error" else doc.parse_log
                    break
            job["processed_files"] = sum(1 for f in job.get("documents") or [] if f.get("status") in {"done", "needs_review", "error", "cancelled"})
            job["items_found"] = sum(int(f.get("items") or 0) for f in job.get("documents") or [])
            job["needs_review"] = sum(int(f.get("review_items") or 0) for f in job.get("documents") or [])
            if all(f.get("status") in {"done", "needs_review", "error", "cancelled"} for f in job.get("documents") or []):
                job["status"] = "finished_with_errors" if any(f.get("status") == "error" for f in job.get("documents") or []) else "done"
    except Exception:
        db.rollback()
    finally:
        db.close()
    try:
        import backend.job_state as js
        js.save_jobs_state()
    except Exception:
        pass


def process_file_payload_with_job_id(job_id: str, *args, **kwargs):
    payload = args[0] if args and isinstance(args[0], dict) else {}
    token = CURRENT_JOB_ID.set(job_id)
    try:
        return ORIGINAL_PROCESS_FILE_PAYLOAD(job_id, *args, **kwargs)
    finally:
        CURRENT_JOB_ID.reset(token)
        sync_job_file_from_db(job_id, payload)


@event.listens_for(PriceDocument, "after_insert")
def mark_document_job_id(mapper, connection, target):
    job_id = CURRENT_JOB_ID.get()
    if job_id:
        connection.execute(text("UPDATE price_documents SET job_id=:job_id WHERE doc_id=:doc_id"), {"job_id": job_id, "doc_id": target.doc_id})


@event.listens_for(PriceItem, "after_insert")
def mark_item_job_id(mapper, connection, target):
    job_id = CURRENT_JOB_ID.get()
    if job_id:
        connection.execute(text("UPDATE price_items SET job_id=:job_id WHERE item_id=:item_id"), {"job_id": job_id, "item_id": target.item_id})


ensure_job_id_columns()
main.infer_partner_name = infer_partner_name
main.process_file_payload = process_file_payload_with_job_id
