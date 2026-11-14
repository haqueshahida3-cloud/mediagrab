"""Telegram bot: send a link to the bot, get the video / audio / photos back in the chat.

Setup: create a bot with @BotFather and set TELEGRAM_BOT_TOKEN (and PUBLIC_BASE_URL, or run on Render which provides
RENDER_EXTERNAL_URL). The webhook is registered automatically on start-up. Telegram bots can upload files up to
50 MB; larger results are sent as a temporary download link instead.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .config import settings
from .detect import analyze
from .jobs import manager
from .ratelimit import limiter
from .utils import InvalidURL, detect_platform, validate_public_url
from .ytdl import MediaError

log = logging.getLogger("mediagrab.telegram")
router = APIRouter(prefix="/api/telegram", tags=["telegram"], include_in_schema=False)

MAX_UPLOAD = 49 * 1024 * 1024          # Telegram bot upload limit is 50 MB
MAX_WAIT = 15 * 60                      # give up on a job after 15 minutes
URL_RE = re.compile(r"https?://[^\s<>\"']+")
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
AUDIO_EXT = {".mp3", ".m4a", ".flac", ".opus", ".ogg", ".aac"}
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp"}
DONE = {"finished", "error", "cancelled"}
HELP = (
    "👋 Send me a link from Instagram, TikTok, Facebook, X and more — I'll send the video back.\n\n"
    "/mp3 <link> — get the audio as MP3\n"
    "/help — show this message\n\n"
    "Files over 50 MB come as a temporary download link."
)

_tasks: set[asyncio.Task] = set()
_client: httpx.AsyncClient | None = None


# ---------------------------------------------------------------------------- helpers (pure)
def enabled() -> bool:
    return bool(settings.telegram_token)


def webhook_secret() -> str:
    """Deterministic secret Telegram echoes back in a header (derived from the bot token — nothing extra to configure)."""
    return hashlib.sha256(f"mediagrab-tg:{settings.telegram_token}".encode()).hexdigest()[:48]


def parse_message(text: str) -> tuple[str, str | None]:
    """→ (command, url). command is '' for plain messages; url is the first http(s) link found."""
    text = (text or "").strip()
    cmd = ""
    if text.startswith("/"):
        cmd = text.split()[0].split("@")[0].lower()
    m = URL_RE.search(text)
    return cmd, (m.group(0).rstrip(".,);]") if m else None)


def pick_quality(raw: dict, cap: int = 720) -> str:
    """Highest real resolution ≤ cap (keeps files small enough for Telegram); 'best' if the source has none that low."""
    sizes = set()
    for f in raw.get("formats") or []:
        w, h = f.get("width"), f.get("height")
        if f.get("vcodec") not in (None, "none") and (w or h):
            sizes.add(min(w, h) if (w and h) else (h or w))
    low = [s for s in sizes if s <= cap]
    return str(max(low)) if low else "best"


def send_method(filename: str, size: int) -> tuple[str, str]:
    """→ (Telegram method, form field) for a finished file."""
    ext = Path(filename).suffix.lower()
    if ext in VIDEO_EXT:
        return "sendVideo", "video"
    if ext in AUDIO_EXT:
        return "sendAudio", "audio"
    if ext in PHOTO_EXT and size <= 9 * 1024 * 1024:
        return "sendPhoto", "photo"
    return "sendDocument", "document"


# ---------------------------------------------------------------------------- Telegram API
def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0))
    return _client


async def api(method: str, data: dict | None = None, files: dict | None = None) -> dict:
    r = await _http().post(f"https://api.telegram.org/bot{settings.telegram_token}/{method}", data=data, files=files)
    try:
        body = r.json()
    except ValueError:
        body = {}
    if not body.get("ok"):
        raise RuntimeError(f"telegram {method} failed: {body.get('description') or r.status_code}")
    return body


async def send_text(chat_id: int, text: str) -> None:
    try:
        await api("sendMessage", {"chat_id": chat_id, "text": text[:4000], "disable_web_page_preview": "true"})
    except (RuntimeError, httpx.HTTPError) as e:
        log.warning("send_text: %s", e)


async def send_file(chat_id: int, path: str, filename: str, caption: str = "") -> None:
    size = Path(path).stat().st_size
    method, field = send_method(filename, size)
    data = {"chat_id": chat_id, "caption": caption[:900]}
    if method == "sendVideo":
        data["supports_streaming"] = "true"
    with open(path, "rb") as fh:
        await api(method, data, {field: (filename, fh)})


async def setup_webhook() -> None:
    """Register the webhook (best effort, retried a few times — the public URL may not answer yet on first boot)."""
    if not enabled():
        return
    base = settings.base_url
    if not base.startswith("https://"):
        log.warning("telegram: set PUBLIC_BASE_URL (https://…) so the webhook can be registered")
        return
    for attempt in range(5):
        try:
            await api("setWebhook", {"url": f"{base}/api/telegram/webhook", "secret_token": webhook_secret(),
                                     "allowed_updates": '["message"]'})
            log.info("telegram webhook registered: %s/api/telegram/webhook", base)
            return
        except (RuntimeError, httpx.HTTPError) as e:
            log.warning("telegram setWebhook attempt %s failed: %s", attempt + 1, e)
            await asyncio.sleep(10 * (attempt + 1))


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


# ---------------------------------------------------------------------------- download flow
def _friendly(e: Exception) -> str:
    if isinstance(e, (MediaError, InvalidURL)):
        return str(getattr(e, "message", None) or e)
    return "Something went wrong. Please try again."


async def run_download(chat_id: int, url: str, audio: bool) -> None:
    ip = f"tg:{chat_id}"
    try:
        url = await run_in_threadpool(validate_public_url, url)
        platform = detect_platform(url)
        options = {"trim_start_s": None, "trim_end_s": None, "precise_cut": False, "sponsorblock": False,
                   "embed_subs": False, "sub_lang": None, "prefer_h264": True, "embed_metadata": audio,
                   "filename": None, "items": []}
        title = ""
        if audio:
            kind, quality, label = "audio", "mp3-128", "128kbps"
        else:
            result = await run_in_threadpool(analyze, url, False)
            if result.get("gallery"):
                kind, quality, label = "gallery", "all", "Photos"
                title = (result["gallery"].get("title") or "")[:200]
            else:
                raw = result.get("raw") or {}
                if raw.get("is_live") or raw.get("live_status") in ("is_live", "is_upcoming"):
                    raise MediaError("Live streams can't be downloaded until they end.", "live")
                limit = settings.max_duration_minutes * 60
                if limit and (raw.get("duration") or 0) > limit:
                    raise MediaError(f"Videos longer than {settings.max_duration_minutes} minutes aren't allowed here.", "too_long")
                kind, quality = "video", pick_quality(raw)
                label = f"{quality}p" if quality.isdigit() else "best"
                title = (raw.get("title") or "")[:200]
        await api("sendChatAction", {"chat_id": chat_id, "action": "upload_video" if kind == "video" else "typing"})
        job = manager.create(url=url, platform=platform, kind=kind, quality=quality, options=options,
                             client_ip=ip, title=title, thumbnail=None, label=label)
        await send_text(chat_id, "⏳ Downloading… I'll send it as soon as it's ready.")

        deadline = time.monotonic() + MAX_WAIT
        while job.status not in DONE:
            if time.monotonic() > deadline:
                manager.cancel(job.id)
                await send_text(chat_id, "⌛ This took too long and was stopped. Try a shorter video.")
                return
            await asyncio.sleep(2)
        if job.status != "finished":
            await send_text(chat_id, f"❌ {job.error or 'The download failed.'}")
            return

        size = Path(job.filepath).stat().st_size
        if size <= MAX_UPLOAD:
            await send_file(chat_id, job.filepath, job.filename or Path(job.filepath).name, job.title)
        else:
            base = settings.base_url
            link = f"{base}/api/jobs/{job.id}/file" if base else None
            mb = size / (1024 * 1024)
            await send_text(chat_id, f"📦 The file is {mb:.0f} MB — too big for Telegram.\n"
                                     + (f"Download it here (valid {settings.file_ttl_minutes} min):\n{link}" if link else
                                        "Please use the website instead."))
    except HTTPException:
        await send_text(chat_id, "Please wait a moment and try again.")
    except Exception as e:  # noqa: BLE001 — never let one chat's failure bubble up
        log.warning("telegram job failed: %s", e)
        await send_text(chat_id, f"❌ {_friendly(e)}")


async def handle_update(update: dict) -> None:
    msg = update.get("message") or update.get("edited_message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    if not chat_id:
        return
    user_id = str((msg.get("from") or {}).get("id", ""))
    allowed = settings.telegram_allowed_ids
    if allowed and user_id not in allowed:
        await send_text(chat_id, "🔒 This bot is private.")
        return

    cmd, url = parse_message(msg.get("text") or msg.get("caption") or "")
    if cmd in ("/start", "/help") or (not cmd and not url):
        await send_text(chat_id, HELP if cmd or not (msg.get("text") or "").strip() else "Please send a link (starting with https://).\n\n" + HELP)
        return
    if not url:
        await send_text(chat_id, "Add a link after the command, e.g. /mp3 https://…")
        return
    try:
        limiter.enforce(f"tg:{chat_id}", 6)
    except HTTPException:
        await send_text(chat_id, "You're going a little fast — please wait a minute.")
        return
    if manager.active_count(f"tg:{chat_id}") >= 2:
        await send_text(chat_id, "You already have 2 downloads running. Please wait for one to finish.")
        return
    await run_download(chat_id, url, audio=(cmd == "/mp3"))


# ---------------------------------------------------------------------------- webhook
@router.post("/webhook")
async def webhook(request: Request):
    if not enabled():
        raise HTTPException(404, "Not found")
    got = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not hmac.compare_digest(got, webhook_secret()):
        raise HTTPException(403, "Forbidden")
    try:
        update = await request.json()
    except ValueError:
        raise HTTPException(400, "Bad request") from None
    if not isinstance(update, dict):
        raise HTTPException(400, "Bad request")
    task = asyncio.create_task(handle_update(update))  # answer Telegram immediately, work in the background
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"ok": True}
