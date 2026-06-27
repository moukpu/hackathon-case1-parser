import shutil
from datetime import datetime
from pathlib import Path

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from backend import catalog_defaults
from db import Service, get_db
from normalizer import dataframe_from_catalog


def _iso_mtime(path: Path | None) -> str | None:
    if not path or not path.exists():
        return None
    return datetime.fromtimestamp(path.stat().st_mtime).isoformat()


def _safe_public_path(path: Path | None) -> str | None:
    if not path:
        return None
    return path.name


def _catalog_rows_count(path: Path | None) -> int | None:
    if not path or not path.is_file():
        return None
    try:
        df = dataframe_from_catalog(path.name, path.read_bytes()).fillna("")
        if df.empty:
            return 0
        # Count likely service rows, not just raw spreadsheet rows.
        columns = {str(c).strip().lower(): c for c in df.columns}
        candidates = ["service_name", "name_ru", "name", "название", "наименование", "услуга"]
        for candidate in candidates:
            column = columns.get(candidate)
            if column is not None:
                return int(df[column].astype(str).str.strip().replace("nan", "").ne("").sum())
        return int(len(df))
    except Exception:
        return None


def _catalog_info(path: Path | None) -> dict:
    exists = bool(path and path.is_file())
    return {
        "exists": exists,
        "file_name": _safe_public_path(path) if exists else None,
        "updated_at": _iso_mtime(path) if exists else None,
        "rows": _catalog_rows_count(path) if exists else None,
    }


def _current_user_catalog_path(user_id: str) -> Path | None:
    return catalog_defaults.first_existing(catalog_defaults.account_candidates(user_id))


def _default_catalog_path() -> Path | None:
    return catalog_defaults.first_existing(catalog_defaults.default_candidates())


@main.app.get("/api/catalog/settings")
async def catalog_settings(db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    user_path = _current_user_catalog_path(current_user.user_id)
    default_path = _default_catalog_path()
    preferred_path = main.preferred_catalog_path(current_user.user_id)
    services_count = db.query(Service).filter(Service.user_id == current_user.user_id, Service.is_active == True).count()  # noqa: E712

    return {
        "services_count": services_count,
        "current_catalog": _catalog_info(user_path),
        "default_catalog": _catalog_info(default_path),
        "active_source": {
            "file_name": _safe_public_path(preferred_path),
            "is_user_catalog": bool(user_path and preferred_path == user_path),
            "is_default_catalog": bool(default_path and preferred_path == default_path),
            "is_bundled": preferred_path == main.BUNDLED_CATALOG_PATH,
        },
        "can_make_default": bool(user_path and user_path.is_file()),
    }


@main.app.post("/api/catalog/make-default")
async def make_current_catalog_default(current_user: AuthUser = Depends(require_user)):
    user_path = _current_user_catalog_path(current_user.user_id)
    if not user_path or not user_path.is_file():
        raise HTTPException(status_code=400, detail="Сначала загрузи справочник для текущего аккаунта.")

    suffix = user_path.suffix.lower()
    if suffix not in main.CATALOG_EXTENSIONS:
        suffix = ".xlsx"
    for old in catalog_defaults.storage().glob(f"{catalog_defaults.DEFAULT_PREFIX}.*"):
        try:
            old.unlink()
        except OSError:
            pass
    default_path = catalog_defaults.storage() / f"{catalog_defaults.DEFAULT_PREFIX}{suffix}"
    shutil.copyfile(user_path, default_path)
    return {
        "message": "Текущий справочник сделан дефолтным для новых аккаунтов.",
        "default_catalog": _catalog_info(default_path),
    }
