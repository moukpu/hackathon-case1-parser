import json
import os
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import BackgroundTasks, Depends, File, Form, HTTPException, UploadFile

from auth import AuthUser, require_user
from backend import main


JOB_PAYLOAD_DIR = Path(os.getenv(
    "JOB_PAYLOAD_DIR",
    str((main.VOLUME_DIR / "job_payloads") if main.VOLUME_DIR.exists() else (main.ROOT_DIR / "job_payloads")),
))
MANIFEST_NAME = "manifest.json"
FINAL_FILE_STATUSES = {"done", "needs_review", "error", "cancelled", "interrupted"}
STOP_STATUSES = {"cancelled", "interrupted"}

ORIGINAL_PROCESS_FILE_PAYLOAD = main.process_file_payload


def job_dir(job_id: str) -> Path:
    return JOB_PAYLOAD_DIR / main.safe_filename(job_id)


def manifest_path(job_id: str) -> Path:
    return job_dir(job_id) / MANIFEST_NAME


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
    tmp.replace(path)


def save_jobs_state() -> None:
    try:
        import backend.job_state as job_state
        job_state.save_jobs_state()
    except Exception:
        pass


def public_job_copy(job: dict) -> dict:
    # Keep secrets out of the manifest. There should not be any, but be explicit.
    return {k: v for k, v in dict(job).items() if k not in {"groq_api_key", "api_key"}}


def persist_payload_files(job_id: str, file_payloads: list[dict]) -> list[dict]:
    target_dir = job_dir(job_id)
    target_dir.mkdir(parents=True, exist_ok=True)

    persisted: list[dict] = []
    for payload in file_payloads:
        index = int(payload["index"])
        filename = f"{index:04d}_{main.safe_filename(payload.get('inner_filename') or 'file')}"
        path = target_dir / filename
        path.write_bytes(payload["contents"])

        clean_payload = {k: v for k, v in payload.items() if k != "contents"}
        clean_payload["content_path"] = str(path)
        persisted.append(clean_payload)

    return persisted


def save_job_manifest(job_id: str, job: dict, file_payloads: list[dict], effective_date_text: str | None) -> Path:
    path = manifest_path(job_id)
    atomic_write_json(
        path,
        {
            "job_id": job_id,
            "saved_at": datetime.utcnow().isoformat(),
            "effective_date": effective_date_text,
            "job": public_job_copy(job),
            "file_payloads": [{k: v for k, v in payload.items() if k != "contents"} for payload in file_payloads],
        },
    )
    return path


def read_job_manifest(job_id: str, job: dict | None = None) -> dict | None:
    path_value = (job or {}).get("manifest_path")
    path = Path(path_value) if path_value else manifest_path(job_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def job_file_status(job: dict, index: int) -> str | None:
    for doc in job.get("documents") or []:
        if doc.get("index") == index:
            return doc.get("status")
    return None


def set_job_interrupted(job_id: str, message: str) -> None:
    now = datetime.utcnow().isoformat()
    with main.JOBS_LOCK:
        job = main.JOBS.get(job_id)
        if not job:
            return
        job["status"] = "interrupted"
        job["error"] = message
        job["finished_at"] = job.get("finished_at") or now
        for doc in job.get("documents") or []:
            if doc.get("status") not in FINAL_FILE_STATUSES:
                doc["status"] = "interrupted"
                doc["error"] = message
        job["processed_files"] = sum(1 for f in job.get("documents") or [] if f.get("status") in FINAL_FILE_STATUSES)
    save_jobs_state()


def recompute_job_totals(job_id: str) -> None:
    with main.JOBS_LOCK:
        job = main.JOBS.get(job_id)
        if not job:
            return
        docs = job.get("documents") or []
        job["processed_files"] = sum(1 for f in docs if f.get("status") in FINAL_FILE_STATUSES)
        job["items_found"] = sum(int(f.get("items") or 0) for f in docs)
        job["needs_review"] = sum(int(f.get("review_items") or 0) for f in docs)
        if docs and all(f.get("status") in FINAL_FILE_STATUSES for f in docs):
            job["status"] = "finished_with_errors" if any(f.get("status") == "error" for f in docs) else "done"
            job["finished_at"] = job.get("finished_at") or datetime.utcnow().isoformat()
    save_jobs_state()


def payload_with_contents(payload: dict) -> dict:
    if payload.get("contents") is not None:
        return payload
    path = Path(payload.get("content_path") or "")
    if not path.is_file():
        raise FileNotFoundError("Исходный файл job не найден на volume.")
    copy = dict(payload)
    copy["contents"] = path.read_bytes()
    return copy


def process_file_payload_persistent(job_id: str, payload: dict, *args, **kwargs):
    with main.JOBS_LOCK:
        job = main.JOBS.get(job_id) or {}
        if job.get("status") in STOP_STATUSES:
            return None
    return ORIGINAL_PROCESS_FILE_PAYLOAD(job_id, payload_with_contents(payload), *args, **kwargs)


def patch_process_file_payload() -> None:
    main.process_file_payload = process_file_payload_persistent


async def upload_file_async_persistent(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    clinic_name: str = Form("Анонимный тест"),
    effective_date: Optional[str] = Form(None),
    current_user: AuthUser = Depends(require_user),
):
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY не настроен.")

    if effective_date:
        try:
            datetime.fromisoformat(effective_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="effective_date должен быть YYYY-MM-DD")

    job_id = str(uuid.uuid4())
    file_payloads: list[dict] = []
    documents = []
    partners_seen = set()
    index = 0

    for upload in files:
        original_bytes = await upload.read()
        for inner_filename, contents in main.iter_input_files(upload.filename, original_bytes):
            partner_name = main.infer_partner_name(upload.filename, inner_filename, clinic_name)
            partners_seen.add(partner_name)
            file_payloads.append(
                {
                    "index": index,
                    "upload_filename": upload.filename,
                    "inner_filename": inner_filename,
                    "partner_name": partner_name,
                    "contents": contents,
                    "user_id": current_user.user_id,
                }
            )
            documents.append(
                {
                    "index": index,
                    "clinic_name": partner_name,
                    "file_name": inner_filename,
                    "status": "pending",
                    "items": 0,
                    "review_items": 0,
                    "error": None,
                }
            )
            index += 1

    if not file_payloads:
        raise HTTPException(status_code=400, detail="В ZIP не найдено поддерживаемых файлов: pdf/xlsx/xls/csv/docx/txt")

    persisted_payloads = persist_payload_files(job_id, file_payloads)
    job = {
        "job_id": job_id,
        "user_id": current_user.user_id,
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
        "manifest_path": str(manifest_path(job_id)),
        "payloads_persisted": True,
    }

    save_job_manifest(job_id, job, persisted_payloads, effective_date)
    with main.JOBS_LOCK:
        main.JOBS[job_id] = job
    save_jobs_state()

    background_tasks.add_task(main.process_upload_job, job_id, persisted_payloads, effective_date, groq_api_key)
    return job


def patch_upload_route() -> None:
    for route in main.app.router.routes:
        if getattr(route, "path", None) == "/api/upload-async" and "POST" in getattr(route, "methods", set()):
            route.endpoint = upload_file_async_persistent
            if hasattr(route, "dependant"):
                route.dependant.call = upload_file_async_persistent


def sync_job_from_db(job_id: str, file_payloads: list[dict]) -> None:
    tracking = sys.modules.get("backend.job_db_tracking")
    if not tracking:
        return
    sync = getattr(tracking, "sync_job_file_from_db", None)
    if not sync:
        return
    for payload in file_payloads:
        try:
            sync(job_id, payload)
        except Exception:
            pass


def resume_job(job_id: str) -> bool:
    with main.JOBS_LOCK:
        job = dict(main.JOBS.get(job_id) or {})
    if not job or job.get("status") not in main.ACTIVE_JOB_STATUSES:
        return False

    manifest = read_job_manifest(job_id, job)
    if not manifest:
        set_job_interrupted(job_id, "Сервер перезапустился, manifest job не найден. Загрузи архив заново.")
        return False

    file_payloads = manifest.get("file_payloads") or []
    if not isinstance(file_payloads, list) or not file_payloads:
        set_job_interrupted(job_id, "Сервер перезапустился, список файлов job пуст. Загрузи архив заново.")
        return False

    sync_job_from_db(job_id, file_payloads)

    with main.JOBS_LOCK:
        job = main.JOBS.get(job_id) or {}
        job["resumed_after_restart"] = True
        job["resumed_at"] = datetime.utcnow().isoformat()
        for doc in job.get("documents") or []:
            if doc.get("status") in {"queued", "processing"}:
                doc["status"] = "pending"
                doc["error"] = None

    pending_payloads: list[dict] = []
    for payload in file_payloads:
        if not isinstance(payload, dict):
            continue
        index = payload.get("index")
        status = job_file_status(job, index)
        if status in FINAL_FILE_STATUSES:
            continue
        path = Path(payload.get("content_path") or "")
        if not path.is_file():
            main.set_job_file(index=index, job_id=job_id, status="error", error="Исходный файл job не найден после рестарта.", items=0, review_items=0)
            continue
        pending_payloads.append(payload)

    if not pending_payloads:
        recompute_job_totals(job_id)
        return False

    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        set_job_interrupted(job_id, "GROQ_API_KEY не настроен после рестарта. Job прерван, очистка не заблокирована.")
        return False

    with main.JOBS_LOCK:
        if job_id in main.JOBS:
            main.JOBS[job_id]["status"] = "queued"
            main.JOBS[job_id]["error"] = None
            main.JOBS[job_id]["finished_at"] = None
    save_jobs_state()

    effective_date = manifest.get("effective_date")
    thread = threading.Thread(
        target=main.process_upload_job,
        args=(job_id, pending_payloads, effective_date, groq_api_key),
        daemon=True,
    )
    thread.start()
    return True


def resume_active_jobs() -> None:
    with main.JOBS_LOCK:
        job_ids = [job_id for job_id, job in main.JOBS.items() if job.get("status") in main.ACTIVE_JOB_STATUSES]
    for job_id in job_ids:
        resume_job(job_id)


patch_process_file_payload()
patch_upload_route()
resume_active_jobs()
