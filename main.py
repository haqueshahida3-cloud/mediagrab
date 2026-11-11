"""MediaGrab — all-in-one media downloader (FastAPI + yt-dlp + FFmpeg + photo engine)."""
from __future__ import annotations

import asyncio
import io
import mimetypes
import re
import shutil
import time
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import unquote, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.concurrency import run_in_threadpool

from . import pages
from .admin import router as admin_router
from .config import settings
from .detect import analyze
from .extras import download_subtitle
from .jobs import manager
from .media import AUDIO_PRESETS, build_any, nice_title
from .monitor import monitor
from .ratelimit import limiter
from .security import security_middleware
from .tools import CONVERT_TARGETS, delete_upload, get_upload, probe_upload, save_upload
from .utils import (
    PLATFORM_HOSTS,
    InvalidURL,
    content_disposition,
    detect_platform,
    is_public_http_url,
    parse_timestamp,
    validate_public_url,
    verify,
)
from .ytdl import MediaError, gallery_cache, has_cookies, info_cache

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/141.0.0.0 Safari/537.36"
)
THUMB_REFERERS = {"cdninstagram.com": "https://www.instagram.com/", "fbcdn.net": "https://www.facebook.com/",
                  "tiktokcdn.com": "https://www.tiktok.com/", "tiktokcdn-us.com": "https://www.tiktok.com/",
                  "twimg.com": "https://x.com/"}
PREVIEW_WIDTHS = {240, 360, 480, 720, 1080}

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
        limits=httpx.Limits(max_connections=40, max_keepalive_connections=10),
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
    description="Download videos, audio and photos from YouTube, Facebook, Instagram, X, TikTok and more.",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
app.middleware("http")(security_middleware)
# compress HTML/CSS/JS/JSON for slow mobile connections (media files are already compressed and excluded)
app.add_middleware(GZipMiddleware, minimum_size=800, exclude_content_types=DEFAULT_EXCLUDED_CONTENT_TYPES + (
    "video/*", "application/octet-stream", "image/heic", "application/x-subrip"))


# ---------------------------------------------------------------------------- errors
@app.exception_handler(MediaError)
async def media_error_handler(_: Request, exc: MediaError):
    return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status)


@app.exception_handler(InvalidURL)
async def invalid_url_handler(_: Request, exc: InvalidURL):
    return JSONResponse({"error": str(exc), "code": "invalid_url"}, status_code=400)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404 and not request.url.path.startswith("/api/"):
        return pages.not_found(request)
    return JSONResponse({"error": exc.detail, "code": f"http_{exc.status_code}"},
                        status_code=exc.status_code, headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    first = (exc.errors() or [{}])[0]
    field = ".".join(str(x) for x in first.get("loc", [])[1:]) or "request"
    return JSONResponse({"error": f"Invalid {field}: {first.get('msg', 'bad value')}", "code": "validation"},
                        status_code=422)


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
    kind: Literal["video", "audio", "gallery"] = "video"
    quality: str = Field("best", max_length=16)
    label: str | None = Field(None, max_length=24)
    playlist_index: int | None = Field(None, ge=1, le=10000)
    items: list[int] | None = Field(None, max_length=500)
    title: str | None = Field(None, max_length=300)
    thumbnail: str | None = Field(None, max_length=4096)
    options: DownloadOptions = Field(default_factory=DownloadOptions)


class SubtitleRequest(BaseModel):
    url: str = Field(..., min_length=4, max_length=4096)
    lang: str = Field(..., min_length=1, max_length=24, pattern=r"^[A-Za-z0-9_\-]+$")
    auto: bool = False
    fmt: Literal["srt", "vtt"] = "srt"


class UploadRef(BaseModel):
    upload_id: str = Field(..., min_length=24, max_length=24, pattern=r"^[a-f0-9]{24}$")


class ConvertRequest(UploadRef):
    target: str = Field("mp3-320", max_length=16)


# ---------------------------------------------------------------------------- core API
@app.get("/api/health", tags=["system"])
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


@app.get("/api/config", tags=["system"])
async def config():
    return {
        "app_name": settings.app_name,
        "version": settings.version,
        "max_duration_minutes": settings.max_duration_minutes,
        "max_playlist_items": settings.max_playlist_items,
        "max_gallery_items": settings.max_gallery_items,
        "max_filesize_mb": settings.max_filesize_mb,
        "max_upload_mb": settings.max_upload_mb,
        "max_concurrent_downloads": settings.max_concurrent_downloads,
        "file_ttl_minutes": settings.file_ttl_minutes,
        "platforms": list(PLATFORM_HOSTS.keys()),
        "audio_presets": [{"id": k, "label": v["label"], "quality": v["quality"]} for k, v in AUDIO_PRESETS.items()],
        "convert_targets": [{"id": k, "label": v["label"]} for k, v in CONVERT_TARGETS.items()],
        "admin": settings.admin_enabled,
    }


@app.post("/api/info", tags=["media"])
async def api_info(body: InfoRequest, request: Request):
    """Detect what a link contains (video / audio / playlist / photo / carousel / album / mixed) and list
    every genuinely available download option."""
    limiter.enforce(f"info:{client_ip(request)}", settings.rate_limit_info)
    url = await run_in_threadpool(validate_public_url, body.url)
    result = await run_in_threadpool(analyze, url, body.playlist)
    return build_any(result, url)


@app.post("/api/formats", tags=["media"])
async def api_formats(body: InfoRequest, request: Request):
    """Every raw format of a video (metadata viewer): resolution, codecs, bitrates, sizes, protocol."""
    limiter.enforce(f"info:{client_ip(request)}", settings.rate_limit_info)
    url = await run_in_threadpool(validate_public_url, body.url)
    result = await run_in_threadpool(analyze, url, False)
    raw = result.get("raw") or {}
    fmts = []
    for f in raw.get("formats") or []:
        w, h = f.get("width"), f.get("height")
        fmts.append({
            "id": f.get("format_id"), "ext": f.get("ext"), "note": f.get("format_note"),
            "width": w, "height": h, "resolution": f"{w}×{h}" if (w and h) else (f.get("resolution") or None),
            "fps": f.get("fps"), "vcodec": None if f.get("vcodec") in (None, "none") else f.get("vcodec"),
            "acodec": None if f.get("acodec") in (None, "none") else f.get("acodec"),
            "tbr": f.get("tbr"), "vbr": f.get("vbr"), "abr": f.get("abr"), "asr": f.get("asr"),
            "channels": f.get("audio_channels"), "dynamic_range": f.get("dynamic_range"),
            "size": f.get("filesize") or f.get("filesize_approx"), "approx": not f.get("filesize"),
            "protocol": f.get("protocol"), "language": f.get("language"),
        })
    return {
        "id": raw.get("id"), "title": nice_title(raw) if raw else None, "duration": raw.get("duration"),
        "extractor": raw.get("extractor_key"), "platform": detect_platform(url), "formats": fmts,
        "gallery": bool(result.get("gallery")),
    }


@app.post("/api/download", tags=["jobs"])
async def api_download(body: DownloadRequest, request: Request):
    """Start a background job. kind = video | audio | gallery (photos/carousel items; several → ZIP)."""
    ip = client_ip(request)
    limiter.enforce(f"dl:{ip}", settings.rate_limit_download)

    quality = (body.quality or "best").strip().lower()
    items: list[int] = []
    if body.kind == "audio":
        if quality not in AUDIO_PRESETS:
            raise HTTPException(400, "Unknown audio format")
        label = AUDIO_PRESETS[quality]["tag"]
    elif body.kind == "gallery":
        items = sorted({i for i in (body.items or []) if 1 <= i <= settings.max_gallery_items})
        quality = "all" if not items else "items"
        label = ""
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

    title = (body.title or "").strip()[:200]
    if body.kind == "gallery":
        g = gallery_cache.peek(url)
        if g:
            sel = [it for it in g["items"] if not items or it["index"] in items]
            if not sel:
                raise HTTPException(400, "Please select at least one item")
            kinds = {it["type"] for it in sel}
            if len(sel) == 1:
                label = {"image": "Photo", "video": "Video", "audio": "Sound"}[sel[0]["type"]]
            else:
                label = (f"{len(sel)} photos" if kinds == {"image"} else f"{len(sel)} files") + " · ZIP"
            title = title or (g.get("title") or "")[:200]
        else:
            label = "Photos"
    else:
        cached = None if body.playlist_index else info_cache.peek(url)
        if cached:
            if cached.get("is_live") or cached.get("live_status") in ("is_live", "is_upcoming"):
                raise MediaError("Live streams and upcoming premieres can't be downloaded until they end.", "live")
            dur = cached.get("duration") or 0
            if settings.max_duration_minutes and dur > settings.max_duration_minutes * 60 and start is None and end is None:
                raise MediaError(
                    f"Videos longer than {settings.max_duration_minutes} minutes aren't allowed on this server. "
                    "Use Trim to download a part of it.", "too_long")
            title = title or nice_title(cached)[:200]

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
        "items": items,
    }
    thumb = body.thumbnail if (body.thumbnail or "").startswith("/api/thumb?") else None
    job = manager.create(
        url=url, platform=platform, kind=body.kind, quality=quality, options=options, client_ip=ip,
        playlist_index=body.playlist_index, title=title, thumbnail=thumb, label=label,
    )
    return manager.public(job)


@app.get("/api/jobs", tags=["jobs"])
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


def _job_or_404(job_id: str):
    job = manager.get(job_id) if re.fullmatch(r"[a-f0-9]{16}", job_id or "") else None
    if not job:
        raise HTTPException(404, "Job not found or expired")
    return job


@app.get("/api/jobs/{job_id}", tags=["jobs"])
async def get_job(job_id: str):
    return manager.public(_job_or_404(job_id))


@app.delete("/api/jobs/{job_id}", tags=["jobs"])
async def delete_job(job_id: str):
    job = _job_or_404(job_id)
    manager.remove(job_id)
    return {"ok": True, "status": job.status}


@app.post("/api/jobs/{job_id}/cancel", tags=["jobs"])
async def cancel_job(job_id: str):
    """Stop a job but keep it in the list (it can be retried). DELETE removes it entirely."""
    _job_or_404(job_id)
    return manager.public(manager.cancel(job_id))


@app.post("/api/jobs/{job_id}/pause", tags=["jobs"])
async def pause_job(job_id: str):
    _job_or_404(job_id)
    return manager.public(manager.pause(job_id))


@app.post("/api/jobs/{job_id}/resume", tags=["jobs"])
async def resume_job(job_id: str, request: Request):
    _job_or_404(job_id)
    limiter.enforce(f"dl:{client_ip(request)}", settings.rate_limit_download)
    return manager.public(manager.resume(job_id))


@app.post("/api/jobs/{job_id}/retry", tags=["jobs"])
async def retry_job(job_id: str, request: Request):
    _job_or_404(job_id)
    limiter.enforce(f"dl:{client_ip(request)}", settings.rate_limit_download)
    return manager.public(manager.retry(job_id))


@app.get("/api/jobs/{job_id}/file", tags=["jobs"])
async def job_file(job_id: str, inline: int = 0):
    job = manager.get(job_id) if re.fullmatch(r"[a-f0-9]{16}", job_id or "") else None
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


@app.post("/api/subtitles", tags=["media"])
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


def _resize(content: bytes, width: int) -> tuple[bytes, str] | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        img = Image.open(io.BytesIO(content))
        if img.format == "JPEG":
            img.draft("RGB", (width, width * 4))
        if img.width <= width:
            return None
        img = img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img
        img.thumbnail((width, width * 4))
        out = io.BytesIO()
        img.save(out, "WEBP", quality=78, method=4)
        return out.getvalue(), "image/webp"
    except Exception:  # noqa: BLE001
        return None


@app.get("/api/thumb", tags=["media"])
async def thumbnail_proxy(u: str = Query(..., max_length=4096), s: str = Query(..., max_length=64),
                          dl: int = 0, name: str = Query("thumbnail", max_length=120), w: int = 0):
    """Signed same-origin image proxy (previews are resized when `w` is given)."""
    if not verify(u, s):
        raise HTTPException(403, "Invalid signature")
    if not await run_in_threadpool(is_public_http_url, u):
        raise HTTPException(403, "Address not allowed")
    assert http_client is not None
    host = (urlparse(u).hostname or "").lower()
    referer = next((ref for dom, ref in THUMB_REFERERS.items() if host.endswith(dom)), None)
    try:
        r = await http_client.get(u, headers={"Referer": referer} if referer else None)
    except httpx.HTTPError:
        raise HTTPException(502, "Could not fetch image") from None
    ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
    if r.status_code != 200 or not ctype.startswith("image/") or len(r.content) > 25 * 1024 * 1024:
        raise HTTPException(502, "Image unavailable")
    content = r.content
    if w in PREVIEW_WIDTHS and not dl:
        resized = await run_in_threadpool(_resize, content, w)
        if resized:
            content, ctype = resized
    headers = {"Cache-Control": "public, max-age=86400"}
    if dl:
        ext = {"image/jpeg": ".jpg", "image/webp": ".webp", "image/png": ".png", "image/gif": ".gif",
               "image/avif": ".avif", "image/heic": ".heic"}.get(ctype, mimetypes.guess_extension(ctype) or ".jpg")
        headers["Content-Disposition"] = content_disposition(f"{name}{ext}")
    return Response(content=content, media_type=ctype, headers=headers)


# ---------------------------------------------------------------------------- Media Tools
@app.post("/api/tools/upload", tags=["tools"])
async def tools_upload(request: Request):
    """Raw-body upload (header `X-Filename`). Files are private, size-limited and auto-deleted."""
    limiter.enforce(f"tools:{client_ip(request)}", settings.rate_limit_tools)
    name = unquote(request.headers.get("x-filename", "file"))[:200]
    length = request.headers.get("content-length")
    meta = await save_upload(request.stream(), name, int(length) if length and length.isdigit() else None)
    return {"upload_id": meta["id"], "name": meta["name"], "size": meta["size"], "kind": meta["kind"],
            "expires_in": settings.file_ttl_minutes * 60}


@app.post("/api/tools/probe", tags=["tools"])
async def tools_probe(body: UploadRef, request: Request):
    limiter.enforce(f"tools:{client_ip(request)}", settings.rate_limit_tools * 3)
    return await run_in_threadpool(probe_upload, body.upload_id)


@app.post("/api/tools/convert", tags=["tools"])
async def tools_convert(body: ConvertRequest, request: Request):
    ip = client_ip(request)
    limiter.enforce(f"tools:{ip}", settings.rate_limit_tools)
    if body.target not in CONVERT_TARGETS:
        raise HTTPException(400, "Unknown output format")
    _, meta = await run_in_threadpool(get_upload, body.upload_id)
    if manager.active_count(ip) >= settings.max_jobs_per_ip:
        raise HTTPException(429, "Too many jobs in progress. Please wait for some to finish.")
    job = manager.create(
        url=f"upload:{body.upload_id}", platform="local", kind="convert", quality=body.target,
        options={"upload_id": body.upload_id, "target": body.target}, client_ip=ip,
        title=meta["name"].rsplit(".", 1)[0][:200], label=CONVERT_TARGETS[body.target]["label"].split(" (")[0],
    )
    return manager.public(job)


@app.delete("/api/tools/upload/{upload_id}", tags=["tools"])
async def tools_delete(upload_id: str):
    await run_in_threadpool(delete_upload, upload_id)
    return {"ok": True}


# ---------------------------------------------------------------------------- admin + pages + static
app.include_router(admin_router)
app.include_router(pages.router)
app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")
monitor.count("boot")
