import json
from datetime import datetime

from fastapi import Query

from backend import main


JOB_STATE_PATH = (main.VOLUME_DIR if main.VOLUME_DIR.exists() else main.ROOT_DIR) / "jobs_state.json"
ORIGINAL_SET_JOB = main.set_job
ORIGINAL_SET_JOB_FILE = main.set_job_file


class PersistentJobs(dict):
    def clear(self) -> None:
        super().clear()
        try:
            JOB_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            JOB_STATE_PATH.write_text("[]", encoding="utf-8")
        except Exception:
            pass


main.JOBS = PersistentJobs(main.JOBS)


def _job_is_active(job: dict) -> bool:
    return job.get("status") in main.ACTIVE_JOB_STATUSES


def _public_job(job: dict) -> dict:
    copy = dict(job)
    copy["is_active"] = _job_is_active(copy)
    return copy


def save_jobs_state() -> None:
    try:
        JOB_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with main.JOBS_LOCK:
            jobs = list(main.JOBS.values())[-50:]
        JOB_STATE_PATH.write_text(json.dumps(jobs, ensure_ascii=False, default=str), encoding="utf-8")
    except Exception:
        pass


def load_jobs_state() -> None:
    if not JOB_STATE_PATH.exists():
        return
    try:
        jobs = json.loads(JOB_STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(jobs, list):
            return
        with main.JOBS_LOCK:
            for job in jobs[-50:]:
                if not isinstance(job, dict) or not job.get("job_id"):
                    continue
                if job.get("status") in main.ACTIVE_JOB_STATUSES:
                    job["status"] = "interrupted"
                    job["error"] = "Сервер перезапустился во время обработки. Нужно загрузить файл заново."
                    job["finished_at"] = job.get("finished_at") or datetime.utcnow().isoformat()
                main.JOBS[job["job_id"]] = job
    except Exception:
        pass


def patched_set_job(job_id: str, **kwargs) -> None:
    ORIGINAL_SET_JOB(job_id, **kwargs)
    save_jobs_state()


def patched_set_job_file(job_id: str, index: int, **kwargs) -> None:
    ORIGINAL_SET_JOB_FILE(job_id, index, **kwargs)
    save_jobs_state()


load_jobs_state()
main.set_job = patched_set_job
main.set_job_file = patched_set_job_file


@main.app.get("/api/jobs")
async def list_jobs(status: str | None = Query(None), limit: int = Query(10, ge=1, le=50)):
    with main.JOBS_LOCK:
        jobs = list(main.JOBS.values())
    jobs.sort(key=lambda j: j.get("created_at") or "", reverse=True)
    if status == "active":
        jobs = [job for job in jobs if _job_is_active(job)]
    return [_public_job(job) for job in jobs[:limit]]


@main.app.get("/api/jobs-latest")
async def latest_job():
    with main.JOBS_LOCK:
        jobs = list(main.JOBS.values())
    jobs.sort(key=lambda j: j.get("created_at") or "", reverse=True)
    active = next((job for job in jobs if _job_is_active(job)), None)
    if active:
        return _public_job(active)
    return _public_job(jobs[0]) if jobs else {"job_id": None}
