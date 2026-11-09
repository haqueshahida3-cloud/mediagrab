"""yt-dlp wrapper: shared options, friendly errors, cookies, YouTube bot-check fallbacks, info cache."""
from __future__ import annotations

import copy
import re
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import yt_dlp
from yt_dlp.utils import DownloadError

from .config import settings
from .utils import detect_platform


class MediaError(Exception):
    def __init__(self, message: str, code: str = "failed", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class CollectLogger:
    """Silent logger that remembers warnings/errors so we can show friendly messages."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def debug(self, msg: str) -> None:  # yt-dlp routes info + debug messages here
        low = msg.lower()
        if "max-filesize" in low or "does not pass filter" in low:
            self.errors.append(msg)

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        self.warnings.append(msg)

    def error(self, msg: str) -> None:
        self.errors.append(msg)


BOT_MARKERS = (
    "sign in to confirm",
    "not a bot",
    "page needs to be reloaded",
)

_ERROR_RULES: list[tuple[tuple[str, ...], str, str]] = [
    (BOT_MARKERS, "bot_check",
     "YouTube is temporarily asking this server to prove it's not a bot. Please try again in a minute "
     "(server admin: add YouTube cookies to fix this permanently)."),
    (("requested format is not available", "requested format not available"), "format_unavailable",
     "The selected quality isn't available for this video. Please choose another quality."),
    (("ffmpeg not found", "ffprobe not found", "ffmpeg is not installed"), "server_ffmpeg",
     "Server misconfiguration: FFmpeg is not installed."),
    (("private video", "this video is private", "video is private"), "private",
     "This video is private."),
    (("confirm your age", "age-restricted", "age restricted", "inappropriate for some users"), "age_restricted",
     "This video is age-restricted and needs a logged-in account (admin can add cookies)."),
    (("login required", "rate-limit reached or login required", "requires login", "log in to",
      "login to", "you need to log in", "cookies for the authentication", "use --cookies",
      "account authentication"), "login_required",
     "This content requires login (private account, age-restricted or rate-limited). "
     "The server admin can add cookies to unlock it."),
    (("not available in your country", "geo restricted", "geo-restricted", "blocked it in your country",
      "not available from your location", "not made this video available in your country"), "geo_blocked",
     "This video is not available in the server's region."),
    (("unsupported url",), "unsupported",
     "This link isn't supported. Please paste a direct link to a video or post."),
    (("no video could be found", "no video formats found", "there's no video in this post",
      "no media found", "no video in this", "does not contain a video"), "no_video",
     "No downloadable video was found at this link."),
    (("live event will begin", "premieres in", "this live event", "is live now", "is currently live"), "live",
     "Live streams and upcoming premieres can't be downloaded until they end."),
    (("video unavailable", "has been removed", "does not exist", "http error 404", "this content isn't available",
      "content is not available", "this video has been deleted", "post isn't available", "suspended"), "unavailable",
     "This video is unavailable — it may have been deleted or made private."),
    (("http error 429", "too many requests"), "rate_limited",
     "The platform is rate-limiting this server. Please try again in a few minutes."),
    (("http error 403", "forbidden"), "forbidden",
     "The platform refused the download (HTTP 403). Please try again."),
    (("timed out", "timeout", "temporarily unavailable", "connection reset", "remote end closed",
      "name or service not known", "network is unreachable"), "network",
     "The platform took too long to respond. Please try again."),
    (("larger than max-filesize", "max-filesize", "file is larger than"), "too_large",
     "This file is larger than the server's download limit."),
    (("cancelled", "canceled"), "cancelled", "Download cancelled."),
]


def is_bot_check(msg: str | None) -> bool:
    m = (msg or "").lower()
    return any(marker in m for marker in BOT_MARKERS)


def humanize_error(msg: str | None) -> tuple[str, str]:
    """Return (code, friendly_message) for a raw yt-dlp error string."""
    raw = re.sub(r"\x1b\[[0-9;]*m", "", msg or "")
    raw = re.sub(r"^\s*ERROR:\s*", "", raw).strip()
    raw = re.sub(r"^\[[^\]]+\]\s*[^:\s]{0,80}:\s*", "", raw)
    low = raw.lower()
    for keys, code, friendly in _ERROR_RULES:
        if any(k in low for k in keys):
            return code, friendly
    raw = raw.split("\n")[0].strip()
    return "failed", (raw[:280] or "Something went wrong while processing this link.")


def _cookie_source(platform: str) -> Path | None:
    candidates: list[Path] = []
    if settings.cookies_dir:
        cdir = Path(settings.cookies_dir)
        candidates.append(cdir / f"{platform}.txt")
        if platform == "twitter":
            candidates.append(cdir / "x.txt")
    if settings.cookies_file:
        candidates.append(Path(settings.cookies_file))
    for c in candidates:
        if c.is_file() and c.stat().st_size > 0:
            return c
    return None


def has_cookies(platform: str) -> bool:
    return _cookie_source(platform) is not None


def base_opts(platform: str, logger: CollectLogger, youtube_clients: list[str] | None = None) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": logger,
        "noplaylist": True,
        "socket_timeout": 25,
        "retries": 4,
        "fragment_retries": 6,
        "extractor_retries": 2,
        "file_access_retries": 2,
        "concurrent_fragment_downloads": 4,
        "geo_bypass": True,
        "ignoreerrors": False,
        "overwrites": True,
        "updatetime": False,
        "cachedir": str(settings.cache_dir),
        "color": {"stdout": "no_color", "stderr": "no_color"},
        "js_runtimes": {rt: {} for rt in settings.js_runtimes},
    }
    if settings.ffmpeg_location:
        opts["ffmpeg_location"] = settings.ffmpeg_location
    if settings.proxy:
        opts["proxy"] = settings.proxy
    if platform == "youtube":
        opts["extractor_args"] = {"youtube": {"player_client": youtube_clients or settings.youtube_clients}}
    return opts


@contextmanager
def private_cookies(platform: str, workdir: Path | None = None) -> Iterator[str | None]:
    """Copy the platform cookie file to a private location (yt-dlp rewrites cookie files on exit)."""
    src = _cookie_source(platform)
    if not src:
        yield None
        return
    tmp = None
    try:
        if workdir is None:
            tmp = tempfile.mkdtemp(prefix="ck-", dir=settings.tmp_dir)
            workdir = Path(tmp)
        dst = workdir / ".cookies.txt"
        shutil.copyfile(src, dst)
        yield str(dst)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def youtube_attempts(platform: str, first: list[str] | None = None) -> list[list[str] | None]:
    if platform != "youtube":
        return [None]
    attempts: list[list[str] | None] = [first or settings.youtube_clients]
    for group in settings.youtube_fallback_clients:
        if group not in attempts:
            attempts.append(group)
    return attempts


# Popular languages offered as auto-translated captions
POPULAR_SUB_LANGS = ["en", "bn", "hi", "ar", "ur", "es", "fr", "de", "pt", "ru", "id", "tr", "ja", "ko", "zh-Hans"]


def _slim_info(info: dict) -> dict:
    """Drop heavy fields we never use so the cache stays small."""
    autos = info.get("automatic_captions") or {}
    if autos:
        keep = {k: v for k, v in autos.items() if k.endswith("-orig") or k in POPULAR_SUB_LANGS}
        info["automatic_captions"] = keep
    # Drop heavy fields + results of the *previous* format selection. Leaving "requested_formats" in
    # would make a later re-processing (with a different quality) download the stale selection.
    for key in ("heatmap", "storyboards", "requested_formats", "requested_downloads", "requested_subtitles",
                "_filename", "filename", "filepath"):
        info.pop(key, None)
    info["formats"] = [
        f for f in (info.get("formats") or [])
        if f.get("format_note") != "storyboard" and f.get("ext") != "mhtml"
    ]
    return info


def extract_info(url: str, playlist: bool = False) -> dict:
    """Extract metadata (no download). Retries YouTube with alternate player clients on bot checks."""
    platform = detect_platform(url)
    last_error = ""
    for clients in youtube_attempts(platform):
        logger = CollectLogger()
        info: dict | None = None
        with private_cookies(platform) as cookiefile:
            opts = base_opts(platform, logger, clients)
            opts.update({
                "skip_download": True,
                "noplaylist": not playlist,
                "extract_flat": "in_playlist",
                "playlistend": settings.max_playlist_items,
            })
            if cookiefile:
                opts["cookiefile"] = cookiefile
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    info = ydl.sanitize_info(info)
            except DownloadError as e:
                last_error = str(e)
                if is_bot_check(last_error):
                    continue
                break
            except Exception as e:  # extractor crash
                last_error = f"{type(e).__name__}: {e}"
                break
        if not info:
            last_error = "No media found"
            break
        info["_mg_platform"] = platform
        info["_mg_clients"] = clients
        return _slim_info(info)
    code, msg = humanize_error(last_error)
    raise MediaError(msg, code)


class InfoCache:
    """Small TTL cache of raw info dicts so downloads can skip a second extraction."""

    def __init__(self, ttl: int, max_items: int = 40) -> None:
        self.ttl = ttl
        self.max_items = max_items
        self._data: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> dict | None:
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            ts, info = item
            if time.time() - ts > self.ttl:
                self._data.pop(key, None)
                return None
            return copy.deepcopy(info)

    def peek(self, key: str) -> dict | None:
        """Read-only access without copying (callers must not mutate the result)."""
        with self._lock:
            item = self._data.get(key)
            if not item or time.time() - item[0] > self.ttl:
                return None
            return item[1]

    def set(self, key: str, info: dict) -> None:
        with self._lock:
            self._data[key] = (time.time(), info)
            if len(self._data) > self.max_items:
                oldest = sorted(self._data.items(), key=lambda kv: kv[1][0])[: len(self._data) - self.max_items]
                for k, _ in oldest:
                    self._data.pop(k, None)

    def drop(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)


info_cache = InfoCache(settings.info_cache_ttl)
