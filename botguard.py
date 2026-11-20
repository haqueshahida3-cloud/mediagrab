"""Invisible bot protection (Cloudflare Turnstile or Google reCAPTCHA v3).

How it works
  1. The page asks /api/bot/config which provider to use, runs the invisible check and sends the token to
     /api/bot/verify.
  2. The server verifies the token with the provider (secret key stays on the server) and sets a signed,
     HttpOnly "mg_human" cookie that is valid for BOT_PASS_MINUTES (default 30).
  3. Expensive endpoints (analyze, download, subtitles, tools) require that cookie; without it they answer
     403 {"code": "bot_check_required"} and the front-end silently runs the check and retries.

Off by default. Enabled only when BOT_PROTECTION (turnstile | recaptcha), BOT_SITE_KEY and BOT_SECRET_KEY are set.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import settings
from .ratelimit import limiter

log = logging.getLogger("mediagrab.botguard")
router = APIRouter(prefix="/api/bot", tags=["bot"])

COOKIE = "mg_human"
ACTION = "mediagrab"
# POST endpoints that cost CPU / bandwidth: they need a human pass when protection is on
PROTECTED = frozenset({"/api/info", "/api/download", "/api/subtitles", "/api/tools/upload", "/api/tools/probe",
                       "/api/tools/convert"})
SITEVERIFY = {
    "turnstile": "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    "recaptcha": "https://www.google.com/recaptcha/api/siteverify",
}


# ---------------------------------------------------------------------------- signed pass cookie
def _ua_tag(request: Request) -> str:
    return hashlib.sha256(request.headers.get("user-agent", "").encode()).hexdigest()[:12]


def _sign(payload: str) -> str:
    return hmac.new(settings.secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]


def make_pass(ua_tag: str, now: float | None = None) -> str:
    exp = int((time.time() if now is None else now) + settings.bot_pass_minutes * 60)
    payload = f"{exp}.{ua_tag}"
    return f"{payload}.{_sign(payload)}"


def check_pass(value: str | None, ua_tag: str, now: float | None = None) -> bool:
    if not value:
        return False
    try:
        exp_s, tag, sig = value.split(".")
        exp = int(exp_s)
    except ValueError:
        return False
    if not hmac.compare_digest(sig, _sign(f"{exp_s}.{tag}")):
        return False
    return hmac.compare_digest(tag, ua_tag) and exp > (time.time() if now is None else now)


def has_pass(request: Request) -> bool:
    return check_pass(request.cookies.get(COOKIE), _ua_tag(request))


def blocks(request: Request) -> bool:
    """True when this request must be refused until the human check is done (used by the security middleware)."""
    return (settings.bot_enabled and request.method == "POST" and request.url.path in PROTECTED
            and not has_pass(request))


def blocked_response() -> JSONResponse:
    return JSONResponse({"error": "Please complete the quick human check and try again.", "code": "bot_check_required"},
                        status_code=403)


# ---------------------------------------------------------------------------- provider verification
def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for") if settings.trust_proxy else None
    return (fwd.split(",")[0].strip() if fwd else None) or (request.client.host if request.client else "unknown")


async def siteverify(token: str, ip: str) -> tuple[bool, str]:
    """Ask Cloudflare / Google whether the token is valid. → (ok, reason)."""
    data = {"secret": settings.bot_secret_key, "response": token}
    if ip and ip != "unknown":
        data["remoteip"] = ip
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=5.0)) as c:
            r = await c.post(SITEVERIFY[settings.bot_provider], data=data)
            r.raise_for_status()
            body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("bot siteverify unreachable: %s", e.__class__.__name__)
        return (True, "fail_open") if settings.bot_fail_open else (False, "unreachable")
    if not body.get("success"):
        return False, ",".join(body.get("error-codes") or []) or "rejected"
    if settings.bot_provider == "recaptcha":
        if body.get("action") not in (None, ACTION):
            return False, "wrong_action"
        if float(body.get("score", 0)) < settings.bot_min_score:
            return False, "low_score"
    elif body.get("action") not in (None, "", ACTION):
        return False, "wrong_action"
    return True, "ok"


# ---------------------------------------------------------------------------- API
class VerifyBody(BaseModel):
    token: str = Field(..., min_length=10, max_length=4096)


@router.get("/config")
async def bot_config():
    """Public settings the front-end needs. The secret key is never exposed."""
    if not settings.bot_enabled:
        return {"enabled": False}
    return {"enabled": True, "provider": settings.bot_provider, "site_key": settings.bot_site_key, "action": ACTION}


@router.post("/verify")
async def bot_verify(body: VerifyBody, request: Request):
    from .ytdl import MediaError  # local import keeps this module light for the middleware

    if not settings.bot_enabled:
        return {"ok": True, "enabled": False}
    ip = _client_ip(request)
    limiter.enforce(f"bot:{ip}", 12)
    ok, reason = await siteverify(body.token, ip)
    if not ok:
        raise MediaError("We could not confirm that you are human. Please reload the page and try again.", "bot_failed", 403)
    resp = JSONResponse({"ok": True, "enabled": True, "minutes": settings.bot_pass_minutes})
    resp.set_cookie(COOKIE, make_pass(_ua_tag(request)), max_age=settings.bot_pass_minutes * 60, httponly=True,
                    samesite="lax", secure=request.url.scheme == "https" or
                    request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https", path="/")
    return resp
