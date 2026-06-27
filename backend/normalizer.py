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


AUTO_MATCH_THRESHOLD = 72
REVIEW_MATCH_THRESHOLD = 55
CODE_PREFIX_RE = re.compile(r"^\s*[A-ZА-Я]{1,6}\s*\d+(?:[.,]\d+)*(?:\s*[A-ZА-Я])?[.)\-\s,;:]+", re.I)
TRAILING_COUNT_RE = re.compile(r"\s+\d{1,3}\s*$")


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    value = str(value).lower().replace("ё", "е")
    value = CODE_PREFIX_RE.sub("", value)
    value = TRAILING_COUNT_RE.sub("", value)
    value = re.sub(r"\b(цена|стоимость|тенге|тг|kzt|₸)\b", " ", value)
    value = re.sub(r"[^a-zа-я0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def clean_code(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null", "-"}:
        return None
    if re.fullmatch(r"\d+\.0", text):
        text = text[:-2]
    return text


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
    """Import catalog with minimal SQLite lock time.

    Older version queried inside the row loop. SQLAlchemy autoflush could start a
    write transaction before each SELECT and hold SQLite locked for a long time.
    This version loads existing services once, updates in memory, then commits once.
    """
    df = dataframe_from_catalog(file_name, file_bytes).fillna("")
    created = 0
    updated = 0
    skipped = 0

    existing = db.query(Service).all()
    by_code: dict[str, Service] = {}
    by_name_category: dict[tuple[str, str], Service] = {}
    for service in existing:
        if service.source_code:
            by_code[str(service.source_code)] = service
        by_name_category[(service.service_name or "", service.category or "")] = service

    for raw_row in df.to_dict(orient="records"):
        row = {str(k).strip(): v for k, v in raw_row.items()}
        service_name = first_present(row, ["service_name", "Name_ru", "name", "Название", "Наименование", "Услуга"])
        if not service_name:
            skipped += 1
            continue

        source_code = clean_code(first_present(row, ["Code", "code", "service_code", "source_code", "Код", "Код услуги"]))
        if not source_code:
            source_code = clean_code(first_present(row, ["service_id", "serviceId", "serviceID"]))

        category = first_present(row, ["category", "Категория", "Специальность", "Specialty"])
        tarificatr_code = clean_code(first_present(row, ["TarificatrCode", "tarificatr_code", "Тарификатор", "Код тарификатора"]))
        synonyms = parse_synonyms(first_present(row, ["synonyms", "Синонимы", "aliases", "Альтернативные названия"]))

        category = str(category).strip() if category else None
        service_name = str(service_name).strip()
        name_key = (service_name, category or "")

        service = by_code.get(source_code) if source_code else None
        if service is None:
            service = by_name_category.get(name_key)

        if service:
            service.service_name = service_name
            service.category = category
            service.tarificatr_code = tarificatr_code
            if source_code:
                service.source_code = source_code
                by_code[source_code] = service
            service.set_synonyms(synonyms)
            service.is_active = True
            by_name_category[name_key] = service
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
            if source_code:
                by_code[source_code] = service
            by_name_category[name_key] = service
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

    if not normalized_raw and not code_hint:
        return MatchResult(None, 0, "empty", True)

    if code_hint:
        code = clean_code(code_hint)
        if code:
            service = db.query(Service).filter(or_(Service.source_code == code, Service.tarificatr_code == code)).first()
            if service:
                return MatchResult(service, 100, "code_exact", False)

    services = db.query(Service).filter(Service.is_active == True).all()  # noqa: E712
    if not services:
        return MatchResult(None, 0, "no_catalog", True)

    for service in services:
        variants = [service.service_name, *service.synonyms]
        for variant in variants:
            normalized_variant = normalize_text(variant)
            if normalized_raw == normalized_variant:
                return MatchResult(service, 99, "exact_or_synonym", False)
            if normalized_variant and normalized_variant in normalized_raw and len(normalized_variant) >= 8:
                return MatchResult(service, 94, "contains_catalog_name", False)
            if normalized_raw and normalized_raw in normalized_variant and len(normalized_raw) >= 8:
                return MatchResult(service, 92, "contained_in_catalog_name", False)

    choices: dict[str, Service] = {}
    for service in services:
        normalized_name = normalize_text(service.service_name)
        if normalized_name:
            choices[normalized_name] = service
        for synonym in service.synonyms:
            normalized_synonym = normalize_text(synonym)
            if normalized_synonym:
                choices[normalized_synonym] = service

    if not choices:
        return MatchResult(None, 0, "no_choices", True)

    best = process.extractOne(normalized_raw, list(choices.keys()), scorer=fuzz.WRatio)
    if not best:
        return MatchResult(None, 0, "no_match", True)

    _, score, _ = best
    service = choices[best[0]]

    if score >= threshold:
        return MatchResult(service, float(score), "fuzzy", False)
    if score >= REVIEW_MATCH_THRESHOLD:
        return MatchResult(service, float(score), "fuzzy_low_confidence", True)
    return MatchResult(None, float(score), "unmatched", True)
