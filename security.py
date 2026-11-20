"""Security middleware: HTTPS, secure headers (CSP/HSTS/framing), request size limits, static caching."""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

from . import botguard
from .config import settings

MB = 1024 * 1024
UPLOAD_PATH = "/api/tools/upload"
NO_CSP_PATHS = ("/api/docs", "/api/redoc")  # Swagger UI loads its assets from a CDN


def is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "") if settings.trust_proxy else ""
    return proto.split(",")[0].strip() == "https" or request.url.scheme == "https"


_BOT_CSP = {  # extra sources the chosen provider needs (only added when bot protection is on)
    "turnstile": {"script-src": ["https://challenges.cloudflare.com"], "frame-src": ["https://challenges.cloudflare.com"]},
    "recaptcha": {"script-src": ["https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
                  "frame-src": ["https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"],
                  "connect-src": ["https://www.google.com/recaptcha/"], "img-src": ["https://www.gstatic.com/recaptcha/"]},
}


def csp(https: bool) -> str:
    extra = _BOT_CSP.get(settings.bot_provider, {}) if settings.bot_enabled else {}

    def src(name: str, base: str) -> str:
        return " ".join([base, *extra.get(name, [])])

    parts = [
        "default-src 'self'",
        src("script-src", "script-src 'self'"),
        "style-src 'self' 'unsafe-inline'",
        src("img-src", "img-src 'self' data: blob:"),
        "media-src 'self' blob:",
        "font-src 'self' data:",
        src("connect-src", "connect-src 'self'"),
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        *([src("frame-src", "frame-src")] if extra.get("frame-src") else []),
        f"frame-ancestors {'*' if settings.allow_framing else chr(39) + 'self' + chr(39)}",
    ]
    if https:
        parts.append("upgrade-insecure-requests")
    return "; ".join(parts)


async def security_middleware(request: Request, call_next):
    path = request.url.path
    # 1) Optional HTTPS redirect — only when the proxy explicitly says the request came over plain HTTP
    if settings.force_https and settings.trust_proxy:
        proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        host = request.headers.get("host", "")
        if proto == "http" and not host.startswith(("localhost", "127.0.0.1", "0.0.0.0")):
            return RedirectResponse(str(request.url.replace(scheme="https")), status_code=308)

    # 2) Request size limits (uploads stream with their own limit)
    if request.method in ("POST", "PUT", "PATCH"):
        limit = settings.max_upload_mb * MB if path == UPLOAD_PATH else settings.max_json_body_kb * 1024
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            return JSONResponse({"error": "Request is too large.", "code": "too_large"}, status_code=413)
        if length is None and path != UPLOAD_PATH and request.headers.get("transfer-encoding"):
            return JSONResponse({"error": "Chunked request bodies are not accepted.", "code": "length_required"},
                                status_code=411)

    # 3) Invisible bot protection (no-op unless BOT_PROTECTION + keys are configured)
    if botguard.blocks(request):
        return botguard.blocked_response()

    response = await call_next(request)

    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
    h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    h.setdefault("X-Permitted-Cross-Domain-Policies", "none")
    if not settings.allow_framing:
        h.setdefault("X-Frame-Options", "SAMEORIGIN")
    https = is_https(request)
    if https:
        h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    ctype = h.get("content-type", "")
    if ctype.startswith("text/html") and not path.startswith(NO_CSP_PATHS):
        h.setdefault("Content-Security-Policy", csp(https))
    if path.startswith("/api/") and "cache-control" not in h:
        h["Cache-Control"] = "no-store"
    elif path.startswith("/static/") and response.status_code in (200, 304) and "cache-control" not in h:
        if "v=" in request.url.query or path.startswith(("/static/fonts/", "/static/icons/")):
            # versioned URLs (?v=<version>), fonts and icons never change in place → cache for a week
            h["Cache-Control"] = "public, max-age=604800, stale-while-revalidate=86400"
        else:
            # ES modules import each other without a version → always revalidate (cheap 304 via ETag)
            h["Cache-Control"] = "no-cache"
    return response
