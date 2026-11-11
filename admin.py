"""Admin dashboard API — enabled only when ADMIN_TOKEN (≥12 chars) is set.

Login exchanges the token for a signed, HttpOnly, SameSite=Strict session cookie. Sessions are bound to the
current token (changing ADMIN_TOKEN logs everyone out) and expire after 8 hours.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

import yt_dlp
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .config import settings
from .jobs import manager
from .monitor import monitor
from .ratelimit import limiter
from .security import is_https
from .utils import sign, verify
from .ytdl import gallery_cache, has_cookies, info_cache

router = APIRouter(prefix="/api/admin", tags=["admin"])
COOKIE = "mg_admin"
SESSION_TTL = 8 * 3600
PLATFORMS = ("youtube", "facebook", "instagram", "twitter", "tiktok")


def _binding() -> str:
    return hashlib.sha256(settings.admin_token.encode()).hexdigest()[:16]


def _new_session() -> str:
    payload = f"{int(time.time()) + SESSION_TTL}.{secrets.token_hex(8)}"
    return f"{payload}.{sign('admin:' + _binding() + ':' + payload)}"


def is_admin(request: Request) -> bool:
    if not settings.admin_enabled:
        return False
    parts = request.cookies.get(COOKIE, "").split(".")
    if len(parts) != 3 or not parts[0].isdigit() or int(parts[0]) < time.time():
        return False
    return verify("admin:" + _binding() + ":" + f"{parts[0]}.{parts[1]}", parts[2])


def require_admin(request: Request) -> None:
    if not settings.admin_enabled:
        raise HTTPException(404, "Not found")
    if not is_admin(request):
        raise HTTPException(401, "Admin login required")
    if request.method != "GET" and request.headers.get("x-requested-with") != "MediaGrab":
        raise HTTPException(403, "Missing CSRF header")


def _ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for") if settings.trust_proxy else None
    return (fwd.split(",")[0].strip() if fwd else None) or (request.client.host if request.client else "unknown")


class LoginBody(BaseModel):
    token: str = Field(..., min_length=1, max_length=256)


@router.get("/session")
async def session(request: Request):
    return {"enabled": settings.admin_enabled, "authenticated": is_admin(request)}


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response):
    if not settings.admin_enabled:
        raise HTTPException(404, "Not found")
    limiter.enforce(f"admin:{_ip(request)}", 5, 300)
    if not hmac.compare_digest(body.token.encode(), settings.admin_token.encode()):
        monitor.count("admin.login_failed")
        raise HTTPException(401, "Wrong admin token")
    response.set_cookie(COOKIE, _new_session(), max_age=SESSION_TTL, httponly=True, secure=is_https(request),
                        samesite="strict", path="/")
    monitor.count("admin.login")
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/overview")
async def overview(request: Request):
    require_admin(request)
    snap = monitor.snapshot()
    c = snap["counters"]

    def rate(area: str) -> float | None:
        ok, fail = c.get(f"{area}.ok", 0), c.get(f"{area}.fail", 0)
        return round(ok / (ok + fail) * 100, 1) if ok + fail else None

    try:
        import gallery_dl
        gdl = gallery_dl.version.__version__
    except Exception:  # noqa: BLE001
        gdl = None
    versions = monitor.versions()
    return {
        "app": {"name": settings.app_name, "version": settings.version},
        "versions": {"yt_dlp": yt_dlp.version.__version__, "gallery_dl": gdl, **versions},
        "system": monitor.system(),
        "ffmpeg": {"ok": bool(versions.get("ffmpeg")), "version": versions.get("ffmpeg")},
        "jobs": {"counts": manager.counts(), "stats": {k: v for k, v in manager.stats.items() if k != "started_at"},
                 "list": manager.admin_list(), "workers": settings.max_concurrent_downloads},
        "success": {"info": rate("info"), "download": rate("download"), "gallery": rate("gallery"),
                    "convert": rate("convert")},
        "counters": c,
        "platforms": snap["platforms"],
        "rate_limit": {"blocked": snap["rate_limited"], "tracked_clients": limiter.tracked(),
                       "limits": {"info": settings.rate_limit_info, "download": settings.rate_limit_download,
                                  "tools": settings.rate_limit_tools}},
        "cookies": {p: has_cookies(p) for p in PLATFORMS},
        "notices": snap["notices"],
        "errors": snap["errors"][:100],
        "cache": {"info": len(info_cache), "gallery": len(gallery_cache)},
        "limits": {"max_filesize_mb": settings.max_filesize_mb, "max_duration_minutes": settings.max_duration_minutes,
                   "max_upload_mb": settings.max_upload_mb, "file_ttl_minutes": settings.file_ttl_minutes,
                   "auto_retries": settings.auto_retries},
    }


@router.post("/jobs/{job_id}/cancel")
async def admin_cancel(job_id: str, request: Request):
    require_admin(request)
    job = manager.cancel(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return {"ok": True, "status": job.status}


@router.post("/errors/clear")
async def clear_errors(request: Request):
    require_admin(request)
    with monitor.lock:
        monitor.errors.clear()
        monitor.notices.clear()
    return {"ok": True}


@router.post("/cache/clear")
async def clear_cache(request: Request):
    require_admin(request)
    for cache in (info_cache, gallery_cache):
        with cache._lock:  # noqa: SLF001
            cache._data.clear()  # noqa: SLF001
    return {"ok": True}
