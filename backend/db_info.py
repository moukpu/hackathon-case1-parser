from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import main
from db import DATABASE_BACKEND, Partner, PriceDocument, PriceItem, Service, get_db


@main.app.get("/api/db-info")
async def db_info(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {
        "database": DATABASE_BACKEND,
        "is_postgres": DATABASE_BACKEND == "postgresql",
        "partners": db.query(Partner).count(),
        "services": db.query(Service).count(),
        "documents": db.query(PriceDocument).count(),
        "price_items": db.query(PriceItem).count(),
    }
