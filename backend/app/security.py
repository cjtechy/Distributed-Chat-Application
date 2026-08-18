import hashlib
import hmac
import json
import os
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv
from fastapi import HTTPException, Request, Response

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

SECRET_KEY = os.getenv("SECRET_KEY", "")
SESSION_COOKIE = "dc_session"
MIN_SECRET_BYTES = 32
MESSAGE_MAX_LENGTH = 4000


def secret_bytes() -> bytes:
    return SECRET_KEY.encode("utf-8")


def validate_secret_key() -> None:
    key = SECRET_KEY.strip()
    if not key or key == "change-me-in-production":
        raise RuntimeError(
            "SECRET_KEY is missing or still the example value. "
            "Set a random string of at least 32 characters in backend/.env"
        )
    if len(key.encode("utf-8")) < MIN_SECRET_BYTES:
        raise RuntimeError(
            f"SECRET_KEY must be at least {MIN_SECRET_BYTES} bytes "
            "(RFC 7518 HS256). Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )


def sign_bus_payload(message: dict) -> str:
    data = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
    sig = hmac.new(secret_bytes(), data.encode("utf-8"), hashlib.sha256).hexdigest()
    return json.dumps({"sig": sig, "data": data}, separators=(",", ":"))


def verify_bus_payload(raw) -> dict | None:
    try:
        envelope = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(envelope, dict):
        return None
    sig = envelope.get("sig")
    data = envelope.get("data")
    if not isinstance(sig, str) or not isinstance(data, str):
        return None
    expected = hmac.new(secret_bytes(), data.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def set_session_cookie(response: Response, token: str) -> None:
    secure = os.getenv("COOKIE_SECURE", "").lower() in {"1", "true", "yes"}
    max_age = int(os.getenv("JWT_EXPIRE_HOURS", "24")) * 3600
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=max_age,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, request: Request, bucket: str, limit: int, window_s: int) -> None:
        if os.getenv("AUTH_RATE_LIMIT", "1").lower() in {"0", "false", "off", "no"}:
            return
        ip = request.client.host if request.client else "unknown"
        loopback = ip in {"127.0.0.1", "::1", "localhost"}
        if loopback and os.getenv("AUTH_RATE_LIMIT_LOCAL", "0").lower() not in {"1", "true", "yes"}:
            return
        key = f"{bucket}:{ip}"
        now = time.monotonic()
        q = self._hits[key]
        cutoff = now - window_s
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(status_code=429, detail="Too many attempts. Try again shortly.")
        q.append(now)


rate_limiter = RateLimiter()
