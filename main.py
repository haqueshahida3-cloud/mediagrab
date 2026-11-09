"""MediaGrab — all-in-one social video downloader (FastAPI + yt-dlp + FFmpeg)."""
from __future__ import annotations

import asyncio
import mimetypes
import re
import shutil
import time
from contextlib import asynccontextmanager
from typing import Literal

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .config import settings
from .extras import download_subtitle
from .jobs import manager
from .media import AUDIO_PRESETS, build_response, nice_title
from .ratelimit import RateLimiter
from .utils import (
    PLATFORM_HOSTS,
    InvalidURL,
    content_disposition,
    detect_platform,
    parse_timestamp,
    validate_public_url,
    verify,
)
from .ytdl import MediaError, extract_info, has_cookies, info_cache

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

limiter = RateLimiter()
http_client: httpx.AsyncClient | None = None


async def _janitor() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            await run_in_threadpool(manager.cleanup)
            limiter.prune()
        except Exception:  # noqa: BLE001
            pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(20.0, connect=10.0),
        follow_redirects=True,
        headers={"User-Agent": BROWSER_UA},
        proxy=settings.proxy or None,
    )
    await run_in_threadpool(manager.cleanup)
    task = asyncio.create_task(_janitor())
    try:
        yield
    finally:
        task.cancel()
        await http_client.aclose()
        manager.shutdown()


app = FastAPI(
    title=f"{settings.app_name} API",
    version=settings.version,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------- errors & middleware
@app.exception_handler(MediaError)
async def media_error_handler(_: Request, exc: MediaError):
    return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status)


@app.exception_handler(InvalidURL)
async def invalid_url_handler(_: Request, exc: InvalidURL):
    return JSONResponse({"error": str(exc), "code": "invalid_url"}, status_code=400)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail, "code": f"http_{exc.status_code}"},
                        status_code=exc.status_code, headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    first = (exc.errors() or [{}])[0]
    field = ".".join(str(x) for x in first.get("loc", [])[1:]) or "request"
    return JSONResponse({"error": f"Invalid {field}: {first.get('msg', 'bad value')}", "code": "validation"},
                        status_code=422)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.url.path.startswith("/api/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


def client_ip(request: Request) -> str:
    if settings.trust_proxy:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        real = request.headers.get("x-real-ip")
        if real:
            return real.strip()
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------- models
class InfoRequest(BaseModel):
    url: str = Field(..., min_length=4, max_length=4096)
    playlist: bool = False


class DownloadOptions(BaseModel):
    trim_start: str | None = Field(None, max_length=16)
    trim_end: str | None = Field(None, max_length=16)
    precise_cut: bool = False
    sponsorblock: bool = False
    embed_subs: bool = False
    sub_lang: str | None = Field(None, max_length=24)
    prefer_h264: bool = True
    embed_metadata: bool | None = None
    filename: str | None = Field(None, max_length=150)


class DownloadRequest(BaseModel):
    url: str = Field(..., min_length=4, max_length=4096)
    kind: Literal["video", "audio"] = "video"
    quality: str = Field("best", max_length=16)
    label: str | None = Field(None, max_length=24)
    playlist_index: int | None = Field(None, ge=1, le=10000)
    title: str | None = Field(None, max_length=300)
    thumbnail: str | None = Field(None, max_length=4096)
    options: DownloadOptions = Field(default_factory=DownloadOptions)


class SubtitleRequest(BaseModel):
    url: str = Field(..., min_length=4, max_length=4096)
    lang: str = Field(..., min_length=1, max_length=24, pattern=r"^[A-Za-z0-9_\-]+$")
    auto: bool = False
    fmt: Literal["srt", "vtt"] = "srt"


# ---------------------------------------------------------------------------- API
@app.get("/api/health")
async def health():
    ffmpeg_ok = bool(shutil.which("ffmpeg") or settings.ffmpeg_location)
    runtimes = [rt for rt in settings.js_runtimes if shutil.which(rt)]
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
        "yt_dlp": yt_dlp.version.__version__,
        "ffmpeg": ffmpeg_ok,
        "js_runtimes": runtimes,
        "jobs": manager.counts(),
        "stats": {k: v for k, v in manager.stats.items() if k != "started_at"},
        "uptime": int(time.time() - manager.stats["started_at"]),
        "cookies": {p: has_cookies(p) for p in ("youtube", "facebook", "instagram", "twitter", "tiktok")},
    }


@app.get("/api/config")
async def config():
    return {
        "app_name": settings.app_name,
        "version": settings.version,
        "max_duration_minutes": settings.max_duration_minutes,
        "max_playlist_items": settings.max_playlist_items,
        "max_filesize_mb": settings.max_filesize_mb,
        "file_ttl_minutes": settings.file_ttl_minutes,
        "platforms": list(PLATFORM_HOSTS.keys()),
        "audio_presets": [{"id": k, "label": v["label"], "quality": v["quality"]} for k, v in AUDIO_PRESETS.items()],
    }


@app.post("/api/info")
async def api_info(body: InfoRequest, request: Request):
    limiter.enforce(f"info:{client_ip(request)}", settings.rate_limit_info)
    url = await run_in_threadpool(validate_public_url, body.url)
    raw = None if body.playlist else info_cache.peek(url)
    if raw is None:
        raw = await run_in_threadpool(extract_info, url, body.playlist)
        if raw.get("_type") != "playlist":
            info_cache.set(url, raw)
            if raw.get("webpage_url") and raw["webpage_url"] != url:
                info_cache.set(raw["webpage_url"], raw)
    return build_response(raw, url)


@app.post("/api/download")
async def api_download(body: DownloadRequest, request: Request):
    ip = client_ip(request)
    limiter.enforce(f"dl:{ip}", settings.rate_limit_download)

    quality = (body.quality or "best").strip().lower()
    if body.kind == "audio":
        if quality not in AUDIO_PRESETS:
            raise HTTPException(400, "Unknown audio format")
        label = AUDIO_PRESETS[quality]["tag"]
    else:
        if quality != "best" and not (quality.isdigit() and 100 <= int(quality) <= 8640):
            raise HTTPException(400, "Invalid video quality")
        label = (body.label or (f"{quality}p" if quality != "best" else "best")).strip()

    o = body.options
    try:
        start = parse_timestamp(o.trim_start)
        end = parse_timestamp(o.trim_end)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    if start is not None and end is not None and end <= start:
        raise HTTPException(400, "Trim end time must be after the start time")
    if o.sub_lang and not re.fullmatch(r"[A-Za-z0-9_\-]{1,24}", o.sub_lang):
        raise HTTPException(400, "Invalid subtitle language")

    url = await run_in_threadpool(validate_public_url, body.url)
    platform = detect_platform(url)

    if manager.active_count(ip) >= settings.max_jobs_per_ip:
        raise HTTPException(429, f"You already have {settings.max_jobs_per_ip} downloads in progress. "
                                 "Please wait for some to finish.")

    cached = None if body.playlist_index else info_cache.peek(url)
    if cached:
        if cached.get("is_live") or cached.get("live_status") in ("is_live", "is_upcoming"):
            raise MediaError("Live streams and upcoming premieres can't be downloaded until they end.", "live")
        dur = cached.get("duration") or 0
        if settings.max_duration_minutes and dur > settings.max_duration_minutes * 60 and start is None and end is None:
            raise MediaError(
                f"Videos longer than {settings.max_duration_minutes} minutes aren't allowed on this server. "
                "Use Trim to download a part of it.", "too_long")

    options = {
        "trim_start_s": start,
        "trim_end_s": end,
        "precise_cut": o.precise_cut,
        "sponsorblock": o.sponsorblock,
        "embed_subs": o.embed_subs,
        "sub_lang": o.sub_lang,
        "prefer_h264": o.prefer_h264,
        "embed_metadata": o.embed_metadata if o.embed_metadata is not None else body.kind == "audio",
        "filename": (o.filename or "").strip() or None,
    }
    title = (body.title or (nice_title(cached) if cached else "")).strip()[:200]
    thumb = body.thumbnail if (body.thumbnail or "").startswith("/api/thumb?") else None
    job = manager.create(
        url=url, platform=platform, kind=body.kind, quality=quality, options=options, client_ip=ip,
        playlist_index=body.playlist_index, title=title, thumbnail=thumb, label=label,
    )
    return manager.public(job)


@app.get("/api/jobs")
async def list_jobs(ids: str = Query("", max_length=4000)):
    wanted = [i for i in ids.split(",") if re.fullmatch(r"[a-f0-9]{16}", i)][:100]
    jobs, missing = [], []
    for jid in wanted:
        job = manager.get(jid)
        if job:
            jobs.append(manager.public(job))
        else:
            missing.append(jid)
    return {"jobs": jobs, "missing": missing}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found or expired")
    return manager.public(job)


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found or expired")
    manager.remove(job_id)
    return {"ok": True, "status": job.status}


@app.get("/api/jobs/{job_id}/file")
async def job_file(job_id: str, inline: int = 0):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "This download has expired. Please download it again.")
    if job.status != "finished" or not job.filepath:
        raise HTTPException(409, "File is not ready yet")
    path = job.filepath
    try:
        open(path, "rb").close()
    except OSError:
        raise HTTPException(410, "This file has been cleaned up. Please download it again.") from None
    job.served += 1
    media_type = mimetypes.guess_type(job.filename or path)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Content-Disposition": content_disposition(job.filename or "media", inline=bool(inline)),
            "Cache-Control": "private, max-age=600",
        },
    )


@app.post("/api/subtitles")
async def api_subtitles(body: SubtitleRequest, request: Request):
    limiter.enforce(f"dl:{client_ip(request)}", settings.rate_limit_download)
    url = await run_in_threadpool(validate_public_url, body.url)
    path, name, tmp = await run_in_threadpool(download_subtitle, url, body.lang, body.auto, body.fmt)
    media_type = "application/x-subrip" if path.suffix == ".srt" else "text/vtt"
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Content-Disposition": content_disposition(name)},
        background=BackgroundTask(shutil.rmtree, tmp, True),
    )


@app.get("/api/thumb")
async def thumbnail_proxy(u: str = Query(..., max_length=4096), s: str = Query(..., max_length=64),
                          dl: int = 0, name: str = Query("thumbnail", max_length=120)):
    if not verify(u, s):
        raise HTTPException(403, "Invalid signature")
    assert http_client is not None
    try:
        r = await http_client.get(u)
    except httpx.HTTPError:
        raise HTTPException(502, "Could not fetch thumbnail") from None
    ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
    if r.status_code != 200 or not ctype.startswith("image/") or len(r.content) > 15 * 1024 * 1024:
        raise HTTPException(502, "Thumbnail unavailable")
    headers = {"Cache-Control": "public, max-age=86400"}
    if dl:
        ext = {"image/jpeg": ".jpg", "image/webp": ".webp", "image/png": ".png", "image/gif": ".gif",
               "image/avif": ".avif", "image/heic": ".heic"}.get(ctype, mimetypes.guess_extension(ctype) or ".jpg")
        headers["Content-Disposition"] = content_disposition(f"{name}{ext}")
    return Response(content=r.content, media_type=ctype, headers=headers)


# ---------------------------------------------------------------------------- frontend
STATIC = settings.static_dir


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(STATIC / "icons" / "favicon.svg", media_type="image/svg+xml")


@app.get("/robots.txt", include_in_schema=False)
async def robots():
    return Response("User-agent: *\nAllow: /\nDisallow: /api/\n", media_type="text/plain")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
