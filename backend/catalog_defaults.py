import os
from pathlib import Path

from backend import main

ORIGINAL_PERSIST = main.persist_user_catalog
EXTS = main.CATALOG_EXTENSIONS
DEFAULT_PREFIX = "services_catalog_default"
USER_PREFIX = "services_catalog_user_"


def storage() -> Path:
    return main.catalog_storage_dir()


def first_existing(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists() and path.is_file():
            return path
    return None


def account_candidates(user_id: str | None) -> list[Path]:
    if not user_id:
        return []
    prefix = f"{USER_PREFIX}{main.safe_filename(user_id)}"
    return [storage() / f"{prefix}{ext}" for ext in EXTS]


def default_candidates() -> list[Path]:
    return [storage() / f"{DEFAULT_PREFIX}{ext}" for ext in EXTS]


def latest_uploaded() -> Path | None:
    files = [p for p in storage().glob(f"{USER_PREFIX}*.*") if p.suffix.lower() in EXTS]
    if not files:
        return None
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def preferred_catalog_path(user_id: str | None = None) -> Path:
    return (
        first_existing(account_candidates(user_id))
        or first_existing(default_candidates())
        or latest_uploaded()
        or (Path(os.getenv("CATALOG_PATH")) if os.getenv("CATALOG_PATH") and Path(os.getenv("CATALOG_PATH")).exists() else None)
        or main.BUNDLED_CATALOG_PATH
    )


def persist_user_catalog(user_id: str, file_name: str, contents: bytes) -> Path:
    user_path = ORIGINAL_PERSIST(user_id, file_name, contents)
    suffix = user_path.suffix.lower() if user_path.suffix.lower() in EXTS else ".xlsx"
    for old in storage().glob(f"{DEFAULT_PREFIX}.*"):
        try:
            old.unlink()
        except OSError:
            pass
    (storage() / f"{DEFAULT_PREFIX}{suffix}").write_bytes(contents)
    return user_path


main.preferred_catalog_path = preferred_catalog_path
main.persist_user_catalog = persist_user_catalog

try:
    __import__("backend." + "job_db_tracking")
except Exception:
    pass
