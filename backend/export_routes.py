import csv
import io
import re
from datetime import date, datetime
from typing import Iterable

from fastapi import Depends, HTTPException
from fastapi.responses import Response
from openpyxl import Workbook
from sqlalchemy import or_
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend.main import (
    JOBS,
    JOBS_LOCK,
    app,
    item_to_response,
    price_item_matches_query,
)
from db import Partner, PriceItem, get_db


PRICE_EXPORT_COLUMNS = ["Клиника", "Услуга", "Цена KZT", "Категория", "Match %", "Ревью", "Дата"]
REVIEW_EXPORT_COLUMNS = PRICE_EXPORT_COLUMNS + ["Причина"]
JOB_DOC_COLUMNS = ["Клиника", "Файл", "Статус", "Услуг", "Ревью", "Ошибка"]
SUPPORTED_EXPORT_FORMATS = {"csv", "xlsx"}


def safe_export_name(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "_", value or "export")
    return value.strip("._-")[:90] or "export"


def normalize_export_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bool):
        return "да" if value else "нет"
    if value is None:
        return ""
    return value


def price_item_to_export_row(item: PriceItem, include_reason: bool = False) -> dict:
    data = item_to_response(item)
    row = {
        "Клиника": data.get("clinic_name"),
        "Услуга": data.get("standardized_name") or data.get("original_name"),
        "Цена KZT": data.get("price_resident_kzt"),
        "Категория": data.get("category"),
        "Match %": data.get("confidence"),
        "Ревью": "да" if data.get("needs_review") else "нет",
        "Дата": data.get("effective_date"),
    }
    if include_reason:
        row["Причина"] = data.get("note") or ("Нет match" if not data.get("service_id") else "Нужна проверка")
    return row


def job_item_to_export_row(item: dict, include_reason: bool = False) -> dict:
    row = {
        "Клиника": item.get("clinic_name"),
        "Услуга": item.get("standardized_name") or item.get("original_name"),
        "Цена KZT": item.get("price_resident_kzt") or item.get("price"),
        "Категория": item.get("category"),
        "Match %": item.get("confidence"),
        "Ревью": "да" if item.get("needs_review") else "нет",
        "Дата": item.get("effective_date"),
    }
    if include_reason:
        row["Причина"] = item.get("note") or ("Нет match" if not item.get("service_id") else "Нужна проверка")
    return row


def job_doc_to_export_row(doc: dict) -> dict:
    return {
        "Клиника": doc.get("clinic_name"),
        "Файл": doc.get("file_name"),
        "Статус": doc.get("status"),
        "Услуг": doc.get("items"),
        "Ревью": doc.get("review_items"),
        "Ошибка": doc.get("error"),
    }


def rows_to_csv_response(rows: list[dict], columns: list[str], filename: str) -> Response:
    output = io.StringIO()
    output.write("\ufeff")
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: normalize_export_value(row.get(key)) for key in columns})
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
    )


def rows_to_xlsx_response(sheets: dict[str, tuple[list[dict], list[str]]], filename: str) -> Response:
    workbook = Workbook()
    first = True
    for sheet_name, (rows, columns) in sheets.items():
        sheet = workbook.active if first else workbook.create_sheet()
        first = False
        sheet.title = sheet_name[:31]
        sheet.append(columns)
        for row in rows:
            sheet.append([normalize_export_value(row.get(column)) for column in columns])
        for column_cells in sheet.columns:
            max_len = max(len(str(cell.value or "")) for cell in column_cells)
            sheet.column_dimensions[column_cells[0].column_letter].width = min(max(max_len + 2, 12), 45)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return Response(
        content=buffer.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}.xlsx"'},
    )


def export_rows(rows: list[dict], columns: list[str], filename: str, file_format: str) -> Response:
    file_format = (file_format or "csv").lower()
    if file_format not in SUPPORTED_EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail="Поддерживается только csv или xlsx")
    safe_name = safe_export_name(filename)
    if file_format == "xlsx":
        return rows_to_xlsx_response({"data": (rows, columns)}, safe_name)
    return rows_to_csv_response(rows, columns, safe_name)


def active_price_items(db: Session, user_id: str) -> Iterable[PriceItem]:
    return (
        db.query(PriceItem)
        .filter(PriceItem.user_id == user_id, PriceItem.is_active == True)  # noqa: E712
        .order_by(PriceItem.created_at.desc())
        .limit(20000)
        .all()
    )


@app.get("/api/export/search.{file_format}")
async def export_search(file_format: str, q: str, db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    q = (q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="Передай поисковый запрос q")
    items = [item for item in active_price_items(db, current_user.user_id) if price_item_matches_query(item, q)][:5000]
    rows = [price_item_to_export_row(item) for item in items]
    return export_rows(rows, PRICE_EXPORT_COLUMNS, f"search_{q}", file_format)


@app.get("/api/export/partners/{partner_id}/services.{file_format}")
async def export_partner_services(partner_id: str, file_format: str, db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    partner = db.query(Partner).filter(Partner.user_id == current_user.user_id, Partner.partner_id == partner_id).first()
    if not partner:
        raise HTTPException(status_code=404, detail="Партнёр не найден")
    items = (
        db.query(PriceItem)
        .filter(PriceItem.user_id == current_user.user_id, PriceItem.partner_id == partner_id, PriceItem.is_active == True)  # noqa: E712
        .order_by(PriceItem.service_name_raw)
        .limit(20000)
        .all()
    )
    rows = [price_item_to_export_row(item) for item in items]
    return export_rows(rows, PRICE_EXPORT_COLUMNS, f"partner_{partner.name}_services", file_format)


@app.get("/api/export/review.{file_format}")
async def export_review(file_format: str, db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    items = (
        db.query(PriceItem)
        .filter(PriceItem.user_id == current_user.user_id, or_(PriceItem.service_id.is_(None), PriceItem.needs_review == True))  # noqa: E712
        .order_by(PriceItem.created_at.desc())
        .limit(20000)
        .all()
    )
    rows = [price_item_to_export_row(item, include_reason=True) for item in items]
    return export_rows(rows, REVIEW_EXPORT_COLUMNS, "review", file_format)


@app.get("/api/export/jobs/{job_id}.{file_format}")
async def export_job(job_id: str, file_format: str, current_user: AuthUser = Depends(require_user)):
    with JOBS_LOCK:
        job = dict(JOBS.get(job_id) or {})
    if not job or job.get("user_id") != current_user.user_id:
        raise HTTPException(status_code=404, detail="Job не найден. Возможно, сервер перезапустился.")

    item_rows = [job_item_to_export_row(item) for item in job.get("data") or []]
    doc_rows = [job_doc_to_export_row(doc) for doc in job.get("documents") or []]
    filename = f"job_{job_id}"
    file_format = (file_format or "csv").lower()
    if file_format == "xlsx":
        return rows_to_xlsx_response(
            {
                "files": (doc_rows, JOB_DOC_COLUMNS),
                "items": (item_rows, PRICE_EXPORT_COLUMNS),
            },
            safe_export_name(filename),
        )
    if item_rows:
        return rows_to_csv_response(item_rows, PRICE_EXPORT_COLUMNS, safe_export_name(filename))
    return rows_to_csv_response(doc_rows, JOB_DOC_COLUMNS, safe_export_name(filename))
