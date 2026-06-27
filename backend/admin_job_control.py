from datetime import datetime
from pathlib import Path

from fastapi import Depends
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import Partner, PriceDocument, PriceItem, Service, get_db

STOP_STATUSES = {"cancelled", "interrupted"}
ORIGINAL_SET_JOB = main.set_job
ORIGINAL_SET_JOB_FILE = main.set_job_file


def patched_set_job(job_id: str, **kwargs) -> None:
    with main.JOBS_LOCK:
        current = main.JOBS.get(job_id) or {}
        if current.get("status") in STOP_STATUSES:
            return
    ORIGINAL_SET_JOB(job_id, **kwargs)


def patched_set_job_file(job_id: str, index: int, **kwargs) -> None:
    with main.JOBS_LOCK:
        current = main.JOBS.get(job_id) or {}
        if current.get("status") in STOP_STATUSES:
            return
    ORIGINAL_SET_JOB_FILE(job_id, index, **kwargs)


def cancel_jobs_for_user(user_id: str) -> int:
    now = datetime.utcnow().isoformat()
    cancelled = 0
    with main.JOBS_LOCK:
        for job in main.JOBS.values():
            if job.get("user_id") != user_id:
                continue
            if job.get("status") in main.ACTIVE_JOB_STATUSES:
                job["status"] = "cancelled"
                job["finished_at"] = now
                job["error"] = "Обработка отменена админом."
                cancelled += 1
                for doc in job.get("documents") or []:
                    if doc.get("status") in {"pending", "processing", "queued"}:
                        doc["status"] = "cancelled"
                        doc["error"] = "Отменено"
    try:
        import backend.job_state as js
        js.save_jobs_state()
    except Exception:
        pass
    return cancelled


def patch_clear_prices_route() -> None:
    async def clear_prices_safe(db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
        cancelled_jobs = cancel_jobs_for_user(current_user.user_id)
        try:
            stored_paths = [d.stored_path for d in db.query(PriceDocument).filter(PriceDocument.user_id == current_user.user_id).all() if d.stored_path]
            with main.DB_WRITE_LOCK:
                items = db.query(PriceItem).filter(PriceItem.user_id == current_user.user_id).delete(synchronize_session=False)
                docs = db.query(PriceDocument).filter(PriceDocument.user_id == current_user.user_id).delete(synchronize_session=False)
                partners = db.query(Partner).filter(Partner.user_id == current_user.user_id).delete(synchronize_session=False)
                db.commit()
                services_count = db.query(Service).filter(Service.user_id == current_user.user_id).count()
            with main.JOBS_LOCK:
                for job_id in [jid for jid, job in main.JOBS.items() if job.get("user_id") == current_user.user_id]:
                    main.JOBS.pop(job_id, None)
            for stored_path in stored_paths:
                try:
                    path = Path(stored_path)
                    if path.is_file():
                        path.unlink()
                except OSError:
                    pass
            return {
                "message": "Прайсы очищены. Справочник сохранён.",
                "cancelled_jobs": cancelled_jobs,
                "deleted_price_items": items,
                "deleted_documents": docs,
                "deleted_partners": partners,
                "services": services_count,
            }
        except Exception as exc:
            db.rollback()
            return {"message": "Ошибка очистки базы", "error": f"{type(exc).__name__}: {exc}"}

    for route in main.app.router.routes:
        if getattr(route, "path", None) == "/api/admin/clear-prices" and "POST" in getattr(route, "methods", set()):
            route.endpoint = clear_prices_safe
            if hasattr(route, "dependant"):
                route.dependant.call = clear_prices_safe


@main.app.post("/api/admin/cancel-jobs")
async def cancel_jobs(current_user: AuthUser = Depends(require_user)):
    return {"ok": True, "cancelled_jobs": cancel_jobs_for_user(current_user.user_id)}


main.set_job = patched_set_job
main.set_job_file = patched_set_job_file
patch_clear_prices_route()
