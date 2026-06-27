import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from db import User, get_db


AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "medarchive_session")
AUTH_SECRET = os.getenv("AUTH_SECRET") or os.getenv("SECRET_KEY") or "dev-secret-change-me"
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", str(60 * 60 * 24 * 14)))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "1").lower() not in {"0", "false", "no", "off"}


@dataclass
class AuthUser:
    user_id: str
    email: str
    name: str | None = None


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def hash_password(password: str) -> str:
    if len(password or "") < 6:
        raise ValueError("Пароль должен быть минимум 6 символов")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 180_000)
    return f"pbkdf2_sha256$180000${_b64url_encode(salt)}${_b64url_encode(digest)}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, iterations, salt_b64, digest_b64 = stored_hash.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = _b64url_decode(salt_b64)
        expected = _b64url_decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def create_session_token(user: User) -> str:
    payload = {
        "uid": user.user_id,
        "email": user.email,
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
    }
    payload_raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    payload_b64 = _b64url_encode(payload_raw)
    sig = hmac.new(AUTH_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url_encode(sig)}"


def parse_session_token(token: str) -> dict | None:
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        expected = hmac.new(AUTH_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
        actual = _b64url_decode(sig_b64)
        if not hmac.compare_digest(actual, expected):
            return None
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        if int(payload.get("exp") or 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def get_current_user(request: Request, db: Session = Depends(get_db)) -> AuthUser | None:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    payload = parse_session_token(token or "") if token else None
    if not payload:
        return None
    user = db.query(User).filter(User.user_id == payload.get("uid"), User.is_active == True).first()  # noqa: E712
    if not user:
        return None
    return AuthUser(user_id=user.user_id, email=user.email, name=user.name)


def require_user(current_user: AuthUser | None = Depends(get_current_user)) -> AuthUser:
    if not current_user:
        raise HTTPException(status_code=401, detail="Нужно войти в аккаунт")
    return current_user


def public_user(user: User | AuthUser) -> dict:
    return {
        "user_id": user.user_id,
        "email": user.email,
        "name": getattr(user, "name", None),
    }
