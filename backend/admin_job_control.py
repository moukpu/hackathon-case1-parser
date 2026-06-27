import os
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import Partner, PriceDocument, PriceItem, Service, get_db

STOP_STATUSES = {"cancelled", "interrupted"}
ORIGINAL_SET_JOB = main.set_job
ORIGINAL_SET_JOB_FILE = main.set_job_file

JOB_PAYLOAD_DIR = Path(
    os.getenv(
        "JOB_PAYLOAD_DIR",
        str((main.VOLUME_DIR / "job_payloads") if main.VOLUME_DIR.exists() else (main.ROOT_DIR / "job_payloads")),
    )
)


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


def save_job_state() -> None:
    try:
        import backend.job_state as js
        js.save_jobs_state()
    except Exception:
        pass


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
                job["error"] = "Обработка отменена."
                cancelled += 1
                for doc in job.get("documents") or []:
                    if doc.get("status") in {"pending", "processing", "queued"}:
                        doc["status"] = "cancelled"
                        doc["error"] = "Отменено"
    save_job_state()
    return cancelled


def user_job_ids_from_memory(user_id: str) -> set[str]:
    with main.JOBS_LOCK:
        return {
            job_id
            for job_id, job in main.JOBS.items()
            if job.get("user_id") == user_id
        }


def user_job_ids_from_db(db: Session, user_id: str) -> set[str]:
    """Read job_id values added by the tracking patch.

    Old deployments may not have these columns yet, so this helper is intentionally
    tolerant: cleanup should never block the main database clear action.
    """
    job_ids: set[str] = set()
    for table_name in ("price_documents", "price_items"):
        try:
            rows = db.execute(
                text(f'SELECT DISTINCT job_id FROM "{table_name}" WHERE user_id = :user_id AND job_id IS NOT NULL'),
                {"user_id": user_id},
            ).fetchall()
        except Exception:
            continue
        job_ids.update(str(row[0]) for row in rows if row and row[0])
    return job_ids


def job_payload_path(job_id: str) -> Path:
    return JOB_PAYLOAD_DIR / main.safe_filename(job_id)


def remove_directory_safely(path: Path, root: Path) -> tuple[int, int]:
    """Remove a directory only when it is inside the expected payload root."""
    try:
        root_resolved = root.resolve()
        path_resolved = path.resolve()
        path_resolved.relative_to(root_resolved)
    except Exception:
        return 0, 0

    if not path_resolved.is_dir():
        return 0, 0

    files_count = sum(1 for item in path_resolved.rglob("*") if item.is_file())
    try:
        shutil.rmtree(path_resolved)
        return 1, files_count
    except OSError:
        return 0, 0


def cleanup_job_payloads(job_ids: set[str]) -> dict:
    removed_dirs = 0
    removed_files = 0
    JOB_PAYLOAD_DIR.mkdir(parents=True, exist_ok=True)

    for job_id in sorted(job_ids):
        dirs, files = remove_directory_safely(job_payload_path(job_id), JOB_PAYLOAD_DIR)
        removed_dirs += dirs
        removed_files += files

    return {
        "deleted_job_payload_dirs": removed_dirs,
        "deleted_job_payload_files": removed_files,
    }


def cleanup_stored_documents(stored_paths: list[str]) -> int:
    deleted = 0
    for stored_path in stored_paths:
        try:
            path = Path(stored_path)
            if path.is_file():
                path.unlink()
                deleted += 1
        except OSError:
            pass
    return deleted


def clear_prices_for_user(db: Session, user_id: str) -> dict:
    cancelled_jobs = cancel_jobs_for_user(user_id)
    job_ids = user_job_ids_from_memory(user_id) | user_job_ids_from_db(db, user_id)
    stored_paths = [
        document.stored_path
        for document in db.query(PriceDocument).filter(PriceDocument.user_id == user_id).all()
        if document.stored_path
    ]

    with main.DB_WRITE_LOCK:
        items = db.query(PriceItem).filter(PriceItem.user_id == user_id).delete(synchronize_session=False)
        docs = db.query(PriceDocument).filter(PriceDocument.user_id == user_id).delete(synchronize_session=False)
        partners = db.query(Partner).filter(Partner.user_id == user_id).delete(synchronize_session=False)
        db.commit()
        services_count = db.query(Service).filter(Service.user_id == user_id).count()

    with main.JOBS_LOCK:
        for job_id in [jid for jid, job in main.JOBS.items() if job.get("user_id") == user_id]:
            main.JOBS.pop(job_id, None)
    save_job_state()

    deleted_stored_files = cleanup_stored_documents(stored_paths)
    payload_cleanup = cleanup_job_payloads(job_ids)

    return {
        "message": "Прайсы очищены. Справочник сохранён.",
        "cancelled_jobs": cancelled_jobs,
        "deleted_price_items": items,
        "deleted_documents": docs,
        "deleted_partners": partners,
        "deleted_stored_files": deleted_stored_files,
        **payload_cleanup,
        "services": services_count,
    }


def patch_clear_prices_route() -> None:
    async def clear_prices_safe(db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
        try:
            return clear_prices_for_user(db, current_user.user_id)
        except Exception as exc:
            db.rollback()
            return {"message": "Ошибка очистки базы", "error": f"{type(exc).__name__}: {exc}"}

    for route in main.app.router.routes:
        if getattr(route, "path", None) == "/api/admin/clear-prices" and "POST" in getattr(route, "methods", set()):
            route.endpoint = clear_prices_safe
            if hasattr(route, "dependant"):
                route.dependant.call = clear_prices_safe


@main.app.post("/api/admin/cancel-jobs")
async def cancel_jobs_post(current_user: AuthUser = Depends(require_user)):
    return {"ok": True, "cancelled_jobs": cancel_jobs_for_user(current_user.user_id)}


@main.app.get("/api/admin/cancel-jobs")
async def cancel_jobs_get(current_user: AuthUser = Depends(require_user)):
    return {"ok": True, "cancelled_jobs": cancel_jobs_for_user(current_user.user_id)}


main.set_job = patched_set_job
main.set_job_file = patched_set_job_file
patch_clear_prices_route()
