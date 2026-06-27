from fastapi import Depends
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import Partner, PriceDocument, PriceItem, Service, get_db


async def stats_safe(db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    total_docs = db.query(PriceDocument).filter(PriceDocument.user_id == current_user.user_id).count()
    total_items = db.query(PriceItem).filter(PriceItem.user_id == current_user.user_id).count()
    matched_items = db.query(PriceItem).filter(
        PriceItem.user_id == current_user.user_id,
        PriceItem.service_id.isnot(None),
    ).count()
    review_items = db.query(PriceItem).filter(
        PriceItem.user_id == current_user.user_id,
        PriceItem.needs_review == True,  # noqa: E712
    ).count()
    clean_items = db.query(PriceItem).filter(
        PriceItem.user_id == current_user.user_id,
        PriceItem.service_id.isnot(None),
        PriceItem.needs_review == False,  # noqa: E712
    ).count()
    unmatched_items = db.query(PriceItem).filter(
        PriceItem.user_id == current_user.user_id,
        PriceItem.service_id.is_(None),
    ).count()

    return {
        "partners": db.query(Partner).filter(Partner.user_id == current_user.user_id).count(),
        "services": db.query(Service).filter(Service.user_id == current_user.user_id).count(),
        "documents": total_docs,
        "price_items": total_items,
        "matched_items": matched_items,
        "clean_items": clean_items,
        "unmatched_items": unmatched_items,
        "needs_review": review_items,
        "match_percent": round((matched_items / total_items * 100), 2) if total_items else 0,
        "auto_normalization_percent": round((clean_items / total_items * 100), 2) if total_items else 0,
        "review_percent": round((review_items / total_items * 100), 2) if total_items else 0,
        "catalog_source": str(main.preferred_catalog_path(current_user.user_id)),
    }


for route in main.app.router.routes:
    if getattr(route, "path", None) == "/api/stats" and "GET" in getattr(route, "methods", set()):
        route.endpoint = stats_safe
        if hasattr(route, "dependant"):
            route.dependant.call = stats_safe
