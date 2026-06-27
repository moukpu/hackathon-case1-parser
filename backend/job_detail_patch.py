from datetime import datetime

from fastapi import Depends

from auth import AuthUser, require_user
from backend import main


def safe_payload(job_id: str) -> dict:
    return {
        "job_id": job_id,
        "status": "interrupted",
        "is_active": False,
        "finished_at": datetime.utcnow().isoformat(),
        "total_files": 0,
        "processed_files": 0,
        "items_found": 0,
        "needs_review": 0,
        "documents": [],
        "data": [],
        "error": "Restart during processing. Upload again.",
    }


async def safe_get_job(job_id: str, current_user: AuthUser = Depends(require_user)):
    with main.JOBS_LOCK:
        job = main.JOBS.get(job_id)
    if not job:
        return safe_payload(job_id)
    if job.get("user_id") != current_user.user_id:
        return safe_payload(job_id)
    out = dict(job)
    out.pop("user_id", None)
    out["is_active"] = out.get("status") in main.ACTIVE_JOB_STATUSES
    return out


for route in main.app.router.routes:
    if getattr(route, "path", None) == "/api/jobs/{job_id}" and "GET" in getattr(route, "methods", set()):
        route.endpoint = safe_get_job
        if hasattr(route, "dependant"):
            route.dependant.call = safe_get_job
