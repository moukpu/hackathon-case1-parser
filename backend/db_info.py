from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import AuthUser, require_user
from backend import main
from db import DATABASE_BACKEND, Partner, PriceDocument, PriceItem, Service, get_db


@main.app.get("/api/db-info")
async def db_info(db: Session = Depends(get_db), current_user: AuthUser = Depends(require_user)):
    db.execute(text("SELECT 1"))
    return {
        "database": DATABASE_BACKEND,
        "is_postgres": DATABASE_BACKEND == "postgresql",
        "partners": db.query(Partner).filter(Partner.user_id == current_user.user_id).count(),
        "services": db.query(Service).filter(Service.user_id == current_user.user_id).count(),
        "documents": db.query(PriceDocument).filter(PriceDocument.user_id == current_user.user_id).count(),
        "price_items": db.query(PriceItem).filter(PriceItem.user_id == current_user.user_id).count(),
    }
