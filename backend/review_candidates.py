from fastapi import Depends, HTTPException
from rapidfuzz import fuzz
from sqlalchemy import or_
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import LOW_PRICE_REVIEW_THRESHOLD_KZT, PriceItem, Service, get_db
from normalizer import AUTO_MATCH_THRESHOLD, normalize_text


NO_MATCH_METHODS = {"unmatched", "no_match", "no_catalog", "no_choices", "empty"}
LOW_CONFIDENCE_METHODS = {"fuzzy_low_confidence"}


def review_reason(item: PriceItem) -> str:
    note = (item.verification_note or "").casefold()
    method = (item.match_method or "").casefold()
    confidence = float(item.match_confidence or 0)
    price = item.price_resident_kzt

    if "подозрительно низкая цена" in note or (price is not None and 0 < float(price) < LOW_PRICE_REVIEW_THRESHOLD_KZT):
        return "low_price"
    if item.service_id is None or method in NO_MATCH_METHODS:
        return "no_match"
    if method in LOW_CONFIDENCE_METHODS or confidence < AUTO_MATCH_THRESHOLD:
        return "low_confidence"
    return "needs_review"


def review_reason_label(reason: str) -> str:
    return {
        "low_price": "подозрительно низкая цена",
        "no_match": "нет совпадения",
        "low_confidence": "низкая уверенность",
        "needs_review": "нужно проверить",
    }.get(reason or "", "нужно проверить")


def item_public(item: PriceItem) -> dict:
    data = main.item_to_response(item)
    reason = review_reason(item)
    data["review_reason"] = reason
    data["review_reason_label"] = review_reason_label(reason)
    data["display_note"] = review_reason_label(reason)
    return data


def service_values(service: Service) -> list[str]:
    values = [service.service_name, service.category, service.source_code, service.tarificatr_code, *service.synonyms]
    return [str(v) for v in values if v]


def candidate_score(service: Service, query: str) -> int:
    query_norm = normalize_text(query)
    if not query_norm:
        return 0
    best = 0
    for value in service_values(service):
        value_norm = normalize_text(value)
        if not value_norm:
            continue
        if query_norm == value_norm:
            best = max(best, 120)
        elif query_norm in value_norm and len(query_norm) >= 5:
            best = max(best, 105)
        elif value_norm in query_norm and len(value_norm) >= 8:
            best = max(best, 98)
        else:
            best = max(best, int(fuzz.WRatio(query_norm, value_norm)))
    return best


@main.app.get("/api/review/items")
async def review_items(reason: str | None = None, db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    items = (
        db.query(PriceItem)
        .filter(
            PriceItem.user_id == current_user.user_id,
            or_(PriceItem.service_id.is_(None), PriceItem.needs_review == True),  # noqa: E712
        )
        .order_by(PriceItem.created_at.desc())
        .limit(500)
        .all()
    )
    output = [item_public(item) for item in items]
    if reason:
        output = [item for item in output if item.get("review_reason") == reason]
    return output


@main.app.get("/api/review/items/{item_id}/candidates")
async def review_item_candidates(item_id: str, db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    item = db.query(PriceItem).filter(PriceItem.user_id == current_user.user_id, PriceItem.item_id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Позиция ревью не найдена")

    query = item.normalized_name or item.service_name_raw or ""
    services = (
        db.query(Service)
        .filter(Service.user_id == current_user.user_id, Service.is_active == True)  # noqa: E712
        .order_by(Service.category, Service.service_name)
        .limit(20000)
        .all()
    )
    ranked = [(candidate_score(service, query), service) for service in services]
    ranked = [(score, service) for score, service in ranked if score >= 45]
    ranked.sort(key=lambda pair: (-pair[0], normalize_text(pair[1].service_name)))

    return {
        "item": item_public(item),
        "candidates": [
            {
                "service_id": service.service_id,
                "service_name": service.service_name,
                "category": service.category,
                "source_code": service.source_code,
                "tarificatr_code": service.tarificatr_code,
                "score": min(int(score), 100),
            }
            for score, service in ranked[:5]
        ],
    }
