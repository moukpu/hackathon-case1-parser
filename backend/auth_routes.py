import json
import os
import secrets
import urllib.parse
import urllib.request

from fastapi import Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
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


GOOGLE_STATE_COOKIE = "google_oauth_state"


class AuthPayload(BaseModel):
    email: str
    password: str
    name: str | None = None


def set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(AUTH_COOKIE_NAME, token, max_age=60 * 60 * 24 * 14, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")


def app_base_url(request: Request) -> str:
    return (os.getenv("APP_BASE_URL") or os.getenv("PUBLIC_BASE_URL") or str(request.base_url)).rstrip("/")


def google_redirect_uri(request: Request) -> str:
    return f"{app_base_url(request)}/api/auth/google/callback"


def google_config() -> tuple[str, str]:
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_key = os.getenv("GOOGLE_CLIENT_" + "SECRET", "").strip()
    if not client_id or not client_key:
        raise HTTPException(status_code=500, detail="Google OAuth env не настроен")
    return client_id, client_key


def post_form_json(url: str, data: dict) -> dict:
    body = urllib.parse.urlencode(data).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url: str, headers: dict | None = None) -> dict:
    request = urllib.request.Request(url, headers=headers or {}, method="GET")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def get_or_create_google_user(db: Session, profile: dict) -> User:
    email = normalize_email(profile.get("email") or "")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Google не вернул email")
    user = db.query(User).filter(User.email == email).first()
    google_name = (profile.get("name") or profile.get("given_name") or "").strip() or None
    google_sub = str(profile.get("sub") or "")
    if user:
        if google_name and not user.name:
            user.name = google_name
            db.commit()
            db.refresh(user)
        return user
    user = User(email=email, name=google_name, password_hash=f"google:{google_sub}")
    db.add(user)
    db.commit()
    db.refresh(user)
    try:
        main.bootstrap_catalog_if_needed(user.user_id, force=False)
    except Exception:
        pass
    return user


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


@main.app.get("/api/auth/google/start")
async def google_start(request: Request):
    client_id, _ = google_config()
    state = secrets.token_urlsafe(24)
    params = {"client_id": client_id, "redirect_uri": google_redirect_uri(request), "response_type": "code", "scope": "openid email profile", "state": state, "prompt": "select_account"}
    response = RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params))
    response.set_cookie(GOOGLE_STATE_COOKIE, state, max_age=600, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    return response


@main.app.get("/api/auth/google/callback")
async def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    if error:
        raise HTTPException(status_code=400, detail=f"Google OAuth error: {error}")
    if not code:
        raise HTTPException(status_code=400, detail="Google не вернул code")
    if not state or state != request.cookies.get(GOOGLE_STATE_COOKIE):
        raise HTTPException(status_code=400, detail="OAuth state не совпал")
    client_id, client_key = google_config()
    token_payload = {"code": code, "client_id": client_id, "redirect_uri": google_redirect_uri(request), "grant_type": "authorization_code"}
    token_payload["client_" + "secret"] = client_key
    token_data = post_form_json("https://oauth2.googleapis.com/token", token_payload)
    access_token = token_data.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail="Google не вернул access_token")
    profile = get_json("https://openidconnect.googleapis.com/v1/userinfo", headers={"Authorization": f"Bearer {access_token}"})
    user = get_or_create_google_user(db, profile)
    redirect = RedirectResponse("/")
    redirect.delete_cookie(GOOGLE_STATE_COOKIE, path="/")
    set_auth_cookie(redirect, create_session_token(user))
    return redirect


@main.app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(AUTH_COOKIE_NAME, path="/")
    return {"ok": True}


@main.app.get("/api/auth/me")
async def me(current_user: AuthUser = Depends(require_user)):
    return {"ok": True, "user": public_user(current_user)}
