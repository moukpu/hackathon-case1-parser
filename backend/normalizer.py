import io
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Iterable

import pandas as pd
from rapidfuzz import fuzz, process
from sqlalchemy import or_
from sqlalchemy.orm import Session

from db import Service


AUTO_MATCH_THRESHOLD = 85
REVIEW_MATCH_THRESHOLD = 70


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    value = str(value).lower().replace("ё", "е")
    value = re.sub(r"[^a-zа-я0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def parse_synonyms(value: Any) -> list[str]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]

    text = str(value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
    except Exception:
        pass
    return [part.strip() for part in re.split(r"[;|,]", text) if part.strip()]


def first_present(row: dict[str, Any], candidates: Iterable[str]) -> Any:
    lower_map = {str(k).strip().lower(): k for k in row.keys()}
    for candidate in candidates:
        key = lower_map.get(candidate.lower())
        if key is not None:
            value = row.get(key)
            if value is not None and str(value).strip() and str(value).lower() != "nan":
                return value
    return None


def dataframe_from_catalog(file_name: str, file_bytes: bytes) -> pd.DataFrame:
    lower = file_name.lower()
    if lower.endswith(".json"):
        data = json.loads(file_bytes.decode("utf-8"))
        if isinstance(data, dict):
            data = data.get("services", [])
        return pd.DataFrame(data)
    if lower.endswith(".csv"):
        return pd.read_csv(io.BytesIO(file_bytes), dtype=str)

    sheets = pd.read_excel(io.BytesIO(file_bytes), sheet_name=None, dtype=str)
    frames = [df for df in sheets.values() if not df.empty]
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def import_service_catalog(db: Session, file_name: str, file_bytes: bytes) -> dict[str, int]:
    df = dataframe_from_catalog(file_name, file_bytes).fillna("")
    created = 0
    updated = 0
    skipped = 0

    for raw_row in df.to_dict(orient="records"):
        row = {str(k).strip(): v for k, v in raw_row.items()}
        service_name = first_present(row, ["service_name", "Name_ru", "name", "Название", "Наименование", "Услуга"])
        if not service_name:
            skipped += 1
            continue

        source_code = first_present(row, ["service_id", "ID", "id", "Code", "code"])
        category = first_present(row, ["category", "Категория", "Специальность", "Specialty"])
        tarificatr_code = first_present(row, ["TarificatrCode", "tarificatr_code", "Тарификатор"])
        synonyms = parse_synonyms(first_present(row, ["synonyms", "Синонимы", "aliases", "Альтернативные названия"]))

        source_code = str(source_code).strip() if source_code else None
        category = str(category).strip() if category else None
        tarificatr_code = str(tarificatr_code).strip() if tarificatr_code else None
        service_name = str(service_name).strip()

        service = None
        if source_code:
            service = db.query(Service).filter(Service.source_code == source_code).first()
        if service is None and tarificatr_code:
            service = db.query(Service).filter(Service.tarificatr_code == tarificatr_code).first()
        if service is None:
            service = (
                db.query(Service)
                .filter(Service.service_name == service_name, Service.category == category)
                .first()
            )

        if service:
            service.service_name = service_name
            service.category = category
            service.tarificatr_code = tarificatr_code
            if source_code:
                service.source_code = source_code
            service.set_synonyms(synonyms)
            service.is_active = True
            updated += 1
        else:
            service = Service(
                service_id=str(uuid.uuid4()),
                source_code=source_code,
                service_name=service_name,
                category=category,
                tarificatr_code=tarificatr_code,
                is_active=True,
            )
            service.set_synonyms(synonyms)
            db.add(service)
            created += 1

    db.commit()
    return {"created": created, "updated": updated, "skipped": skipped, "total_rows": int(len(df))}


@dataclass
class MatchResult:
    service: Service | None
    confidence: float
    method: str
    needs_review: bool


def match_service(
    db: Session,
    raw_name: str,
    category_hint: str | None = None,
    code_hint: str | None = None,
    threshold: int = AUTO_MATCH_THRESHOLD,
) -> MatchResult:
    raw_name = (raw_name or "").strip()
    normalized_raw = normalize_text(raw_name)
    normalized_category = normalize_text(category_hint)

    if not normalized_raw and not code_hint:
        return MatchResult(None, 0, "empty", True)

    if code_hint:
        code = str(code_hint).strip()
        service = (
            db.query(Service)
            .filter(or_(Service.source_code == code, Service.tarificatr_code == code))
            .first()
        )
        if service:
            return MatchResult(service, 100, "code_exact", False)

    services = db.query(Service).filter(Service.is_active == True).all()  # noqa: E712
    if not services:
        return MatchResult(None, 0, "no_catalog", True)

    for service in services:
        variants = [service.service_name, *service.synonyms]
        for variant in variants:
            if normalized_raw == normalize_text(variant):
                confidence = 98
                if normalized_category and service.category:
                    confidence = min(100, confidence + (2 if normalized_category == normalize_text(service.category) else -5))
                return MatchResult(service, confidence, "exact_or_synonym", confidence < threshold)

    choices: dict[str, Service] = {}
    for service in services:
        base = f"{service.service_name} {service.category or ''} {service.source_code or ''} {service.tarificatr_code or ''}"
        choices[normalize_text(base)] = service
        for synonym in service.synonyms:
            choices[normalize_text(f"{synonym} {service.category or ''}")] = service

    if not choices:
        return MatchResult(None, 0, "no_choices", True)

    best = process.extractOne(normalized_raw, list(choices.keys()), scorer=fuzz.token_sort_ratio)
    if not best:
        return MatchResult(None, 0, "no_match", True)

    _, score, _ = best
    service = choices[best[0]]
    if normalized_category and service.category and normalized_category == normalize_text(service.category):
        score = min(100, score + 5)

    if score >= threshold:
        return MatchResult(service, float(score), "fuzzy", False)
    if score >= REVIEW_MATCH_THRESHOLD:
        return MatchResult(service, float(score), "fuzzy_low_confidence", True)
    return MatchResult(None, float(score), "unmatched", True)
