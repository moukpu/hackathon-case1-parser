from collections import defaultdict
from datetime import date, datetime

from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import get_db


FINAL_OK = {"done", "needs_review"}
ERROR_STATUSES = {"error", "finished_with_errors"}
ACTIVE_STATUSES = {"pending", "queued", "processing"}


def _iso(value) -> str | None:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value) if value is not None else None


def _display_status(statuses: list[str]) -> tuple[str, str]:
    values = {s for s in statuses if s}
    if values & ACTIVE_STATUSES:
        return "processing", "обработка"
    if values & ERROR_STATUSES:
        return "finished_with_errors", "есть ошибки"
    if "interrupted" in values:
        return "interrupted", "обработка прервана"
    if "cancelled" in values:
        return "cancelled", "отменено"
    if "needs_review" in values:
        return "needs_review", "нужно проверить"
    if values and values <= FINAL_OK:
        return "done", "готово"
    return "unknown", "неизвестно"


def _fetch_document_rows(db: Session, user_id: str) -> list[dict]:
    rows = db.execute(
        text(
            "SELECT "
            "d.doc_id, d.file_name, d.parse_status, d.parse_log, d.parsed_at, d.effective_date, "
            "d.job_id, p.name AS clinic_name, "
            "COUNT(i.item_id) AS items_count, "
            "SUM(CASE WHEN i.needs_review = TRUE OR i.service_id IS NULL THEN 1 ELSE 0 END) AS review_count "
            "FROM price_documents d "
            "LEFT JOIN partners p ON p.partner_id = d.partner_id "
            "LEFT JOIN price_items i ON i.doc_id = d.doc_id AND i.user_id = d.user_id "
            "WHERE d.user_id = :user_id "
            "GROUP BY d.doc_id, d.file_name, d.parse_status, d.parse_log, d.parsed_at, d.effective_date, d.job_id, p.name "
            "ORDER BY d.parsed_at DESC "
            "LIMIT 500"
        ),
        {"user_id": user_id},
    ).mappings().all()
    return [dict(row) for row in rows]


def _active_jobs_rows(user_id: str) -> list[dict]:
    with main.JOBS_LOCK:
        jobs = [dict(job) for job in main.JOBS.values() if job.get("user_id") == user_id]
    rows = []
    for job in jobs:
        if job.get("status") not in main.ACTIVE_JOB_STATUSES:
            continue
        for doc in job.get("documents") or []:
            rows.append(
                {
                    "doc_id": f"{job.get('job_id')}:{doc.get('index')}",
                    "file_name": doc.get("file_name"),
                    "parse_status": doc.get("status"),
                    "parse_log": doc.get("error"),
                    "parsed_at": job.get("created_at"),
                    "effective_date": None,
                    "job_id": job.get("job_id"),
                    "clinic_name": doc.get("clinic_name") or job.get("clinic_name"),
                    "items_count": doc.get("items") or 0,
                    "review_count": doc.get("review_items") or 0,
                }
            )
    return rows


def build_history(rows: list[dict]) -> list[dict]:
    grouped: dict[str, dict] = defaultdict(lambda: {
        "history_id": None,
        "job_id": None,
        "created_at": None,
        "clinics": set(),
        "files": [],
        "total_files": 0,
        "items_found": 0,
        "needs_review": 0,
        "statuses": [],
    })

    for row in rows:
        job_id = row.get("job_id")
        history_id = job_id or row.get("doc_id")
        group = grouped[str(history_id)]
        group["history_id"] = str(history_id)
        group["job_id"] = job_id
        parsed_at = _iso(row.get("parsed_at"))
        if parsed_at and (not group["created_at"] or parsed_at > group["created_at"]):
            group["created_at"] = parsed_at
        clinic = row.get("clinic_name") or "Клиника не указана"
        group["clinics"].add(clinic)
        items_count = int(row.get("items_count") or 0)
        review_count = int(row.get("review_count") or 0)
        status = row.get("parse_status") or "unknown"
        group["statuses"].append(status)
        group["files"].append({
            "file_name": row.get("file_name") or "Файл",
            "clinic_name": clinic,
            "status": status,
            "display_status": _display_status([status])[1],
            "items": items_count,
            "review_items": review_count,
            "error": row.get("parse_log"),
            "effective_date": _iso(row.get("effective_date")),
        })
        group["total_files"] += 1
        group["items_found"] += items_count
        group["needs_review"] += review_count

    result = []
    for group in grouped.values():
        status, display = _display_status(group.pop("statuses"))
        clinics = sorted(group.pop("clinics"))
        result.append({
            **group,
            "clinic_name": ", ".join(clinics[:3]) + ("…" if len(clinics) > 3 else ""),
            "status": status,
            "display_status": display,
            "exportable": bool(group.get("job_id")),
        })
    result.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return result[:100]


@main.app.get("/api/upload-history")
async def upload_history(db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    rows = _active_jobs_rows(current_user.user_id) + _fetch_document_rows(db, current_user.user_id)
    return build_history(rows)
