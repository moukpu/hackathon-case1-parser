from fastapi import Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import (
    AUTH_COOKIE_NAME,
    COOKIE_SECURE,
    AuthUser,
    create_session_token,
    hash_password,
    normalize_email,
    public_user,
    require_user,
    verify_password,
)
from backend import main
from db import User, get_db


class AuthPayload(BaseModel):
    email: str
    password: str
    name: str | None = None


def set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        AUTH_COOKIE_NAME,
        token,
        max_age=60 * 60 * 24 * 14,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


@main.app.post("/api/auth/register")
async def register(payload: AuthPayload, response: Response, db: Session = Depends(get_db)):
    email = normalize_email(payload.email)
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Нормальный email укажи")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="Такой email уже зарегистрирован")

    try:
        password_hash = hash_password(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    user = User(email=email, password_hash=password_hash, name=(payload.name or "").strip() or None)
    db.add(user)
    db.commit()
    db.refresh(user)

    # Create the default catalog for the new account right away.
    try:
        main.bootstrap_catalog_if_needed(user.user_id, force=False)
    except Exception:
        pass

    set_auth_cookie(response, create_session_token(user))
    return {"ok": True, "user": public_user(user)}


@main.app.post("/api/auth/login")
async def login(payload: AuthPayload, response: Response, db: Session = Depends(get_db)):
    email = normalize_email(payload.email)
    user = db.query(User).filter(User.email == email, User.is_active == True).first()  # noqa: E712
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    set_auth_cookie(response, create_session_token(user))
    return {"ok": True, "user": public_user(user)}


@main.app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return {"ok": True}


@main.app.get("/api/auth/me")
async def me(current_user: AuthUser = Depends(require_user)):
    return {"ok": True, "user": public_user(current_user)}
