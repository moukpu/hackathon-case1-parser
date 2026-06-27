from contextvars import ContextVar

from sqlalchemy import event, text

from backend import main
from db import PriceDocument, PriceItem, engine

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


def process_file_payload_with_job_id(job_id: str, *args, **kwargs):
    token = CURRENT_JOB_ID.set(job_id)
    try:
        return ORIGINAL_PROCESS_FILE_PAYLOAD(job_id, *args, **kwargs)
    finally:
        CURRENT_JOB_ID.reset(token)


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
main.process_file_payload = process_file_payload_with_job_id
