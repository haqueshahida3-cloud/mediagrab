"""yt-dlp wrapper: shared options, friendly errors, cookies, YouTube fallbacks, info cache, diagnostics."""
from __future__ import annotations

import copy
import re
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, NamedTuple

import yt_dlp
from yt_dlp.extractor.instagram import InstagramIE
from yt_dlp.utils import DownloadError

from .config import settings
from .monitor import monitor
from .utils import detect_platform


class MediaError(Exception):
    def __init__(self, message: str, code: str = "failed", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class CollectLogger:
    """Silent logger that remembers warnings/errors so we can show friendly messages and diagnostics."""

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

    def details(self, limit: int = 6) -> list[str]:
        return [m for m in (self.warnings + self.errors) if "no video formats found" not in m.lower()][-limit:]


BOT_MARKERS = (
    "sign in to confirm",
    "not a bot",
    "page needs to be reloaded",
)

# Errors where another YouTube player client / dropping stale cookies can help
YT_RETRY_MARKERS = BOT_MARKERS + (
    "failed to extract any player response",
    "player responses are invalid",
    "ip is likely being blocked",
    "http error 429",
    "too many requests",
    "http error 403",
    "precondition check failed",
    "requested format is not available",
    "requested format not available",
    "try again later",
    "unable to extract initial player response",
    "no video formats found",
)

_ERROR_RULES: list[tuple[tuple[str, ...], str, str]] = [
    (BOT_MARKERS, "bot_check",
     "YouTube is temporarily asking this server to prove it's not a bot. Please try again in a minute "
     "(server admin: add fresh YouTube cookies to fix this permanently)."),
    (("failed to extract any player response", "player responses are invalid", "ip is likely being blocked"),
     "yt_blocked",
     "YouTube is refusing requests from this server right now. Please try again in a few minutes "
     "(server admin: refresh the YouTube cookies or configure a proxy — see the admin dashboard)."),
    (("quality_unavailable",), "quality_unavailable",
     "This quality isn't available for this video right now. Please choose another quality."),
    (("requested format is not available", "requested format not available"), "format_unavailable",
     "The selected quality isn't available for this video. Please choose another quality."),
    (("ffmpeg not found", "ffprobe not found", "ffmpeg is not installed"), "server_ffmpeg",
     "Server misconfiguration: FFmpeg is not installed."),
    (("postprocessing", "conversion failed", "ffmpeg exited", "error opening output", "invalid data found",
      "could not write header", "error while decoding"), "ffmpeg_failed",
     "Processing failed — FFmpeg could not merge or convert this file. Please try another quality or format."),
    (("private video", "this video is private", "video is private"), "private",
     "This video is private."),
    (("confirm your age", "age-restricted", "age restricted", "inappropriate for some users"), "age_restricted",
     "This video is age-restricted and needs a logged-in account (admin can add cookies)."),
    (("login required", "rate-limit reached or login required", "requires login", "log in to",
      "login to", "you need to log in", "cookies for the authentication", "use --cookies",
      "account authentication", "must be logged in", "authrequired", "only available for registered users"),
     "login_required",
     "This content requires login (private account, age-restricted or rate-limited). "
     "The server admin can add cookies to unlock it."),
    (("not available in your country", "geo restricted", "geo-restricted", "blocked it in your country",
      "not available from your location", "not made this video available in your country"), "geo_blocked",
     "This video is not available in the server's region."),
    (("unsupported url",), "unsupported",
     "This link isn't supported. Please paste a direct link to a video or post."),
    (("no video could be found", "no video formats found", "there's no video in this post", "there is no video",
      "no media found", "no video in this", "does not contain a video"), "no_video",
     "No downloadable video was found at this link."),
    (("live event will begin", "premieres in", "this live event", "is live now", "is currently live"), "live",
     "Live streams and upcoming premieres can't be downloaded until they end."),
    (("video unavailable", "has been removed", "does not exist", "http error 404", "this content isn't available",
      "content is not available", "this video has been deleted", "post isn't available", "suspended"), "unavailable",
     "This content is unavailable — it may have been deleted or made private."),
    (("http error 429", "too many requests"), "rate_limited",
     "The platform is rate-limiting this server. Please try again in a few minutes."),
    (("http error 403", "forbidden"), "forbidden",
     "The platform refused the download (HTTP 403). Please try again."),
    (("timed out", "timeout", "temporarily unavailable", "connection reset", "remote end closed",
      "name or service not known", "network is unreachable", "unable to download", "connection aborted",
      "incompleteread", "ssl", "eof occurred"), "network",
     "The platform took too long to respond. Please try again."),
    (("larger than max-filesize", "max-filesize", "file is larger than"), "too_large",
     "This file is larger than the server's download limit."),
    (("no space left", "disk_full"), "disk_full",
     "The server is out of disk space right now. Please try again later."),
    (("cancelled", "canceled"), "cancelled", "Download cancelled."),
]

TRANSIENT_CODES = {"network", "rate_limited", "forbidden"}

# yt-dlp warnings meaning YouTube withheld some formats (PO token / SABR experiments) from this server
FORMATS_HIDDEN_MARKERS = ("formats have been skipped", "require a gvs po token", "sabr", "missing a url",
                          "will be skipped as they may yield http error 403")


def max_video_height(info: dict) -> int:
    best = 0
    for f in info.get("formats") or []:
        if f.get("vcodec") in (None, "none"):
            continue
        w, h = f.get("width") or 0, f.get("height") or 0
        best = max(best, min(w, h) if (w and h) else (h or w))
    return best


def formats_hidden(logger: "CollectLogger") -> bool:
    text = " ".join(logger.warnings).lower()
    return any(m in text for m in FORMATS_HIDDEN_MARKERS)


def is_bot_check(msg: str | None) -> bool:
    m = (msg or "").lower()
    return any(marker in m for marker in BOT_MARKERS)


def is_youtube_retryable(msg: str | None) -> bool:
    m = (msg or "").lower()
    return any(marker in m for marker in YT_RETRY_MARKERS)


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
    raw = re.sub(r";?\s*please report this issue on\s+https?://\S+.*$", "", raw, flags=re.I).strip(" ;,")
    return "failed", (raw[:280] or "Something went wrong while processing this link.")


# ---------------------------------------------------------------------------- cookies
def _cookie_source(platform: str) -> Path | None:
    names = [f"{platform}.txt"] + (["x.txt"] if platform == "twitter" else [])
    candidates: list[Path] = []
    for d in (settings.cookies_dir, settings.secret_files_dir):
        if d:
            candidates += [Path(d) / n for n in names]
    if settings.cookies_file:
        candidates.append(Path(settings.cookies_file))
    for c in candidates:
        try:
            if c.is_file() and c.stat().st_size > 0:
                return c
        except OSError:
            continue
    return None


def has_cookies(platform: str) -> bool:
    return _cookie_source(platform) is not None


@contextmanager
def private_cookies(platform: str, workdir: Path | None = None, enabled: bool = True) -> Iterator[str | None]:
    """Copy the platform cookie file to a private location (yt-dlp rewrites cookie files on exit)."""
    src = _cookie_source(platform) if enabled else None
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
        dst.chmod(0o600)
        yield str(dst)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def base_opts(platform: str, logger: CollectLogger, youtube_clients: list[str] | None = None) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": logger,
        "noplaylist": True,
        "socket_timeout": 25,
        "retries": 5,
        "fragment_retries": 8,
        "extractor_retries": 2,
        "file_access_retries": 3,
        "retry_sleep_functions": {"http": lambda n: min(8, 1.5 * (n + 1)), "fragment": lambda n: min(6, n + 1)},
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


class Attempt(NamedTuple):
    clients: list[str] | None
    cookies: bool


def youtube_attempts(platform: str, first: list[str] | None = None, first_cookies: bool | None = None) -> list[Attempt]:
    """Extraction plan. YouTube: configured clients → fallback clients; with cookies first (if any), then without
    (rotated/flagged cookies are a common cause of 'Failed to extract any player response')."""
    have = has_cookies(platform)
    if platform != "youtube":
        return [Attempt(None, have)]
    groups: list[list[str]] = []
    for g in [first or settings.youtube_clients, *settings.youtube_fallback_clients]:
        if g and g not in groups:
            groups.append(g)
    plan = [Attempt(g, True) for g in groups[:2]] + [Attempt(g, False) for g in groups] if have \
        else [Attempt(g, False) for g in groups]
    if have and first_cookies is False:  # cached info came from a cookie-less attempt — start there
        plan.sort(key=lambda a: a.cookies)
    return plan[:6]


@contextmanager
def ydl_session(platform: str, logger: CollectLogger | None = None, **extra) -> Iterator[yt_dlp.YoutubeDL]:
    """A YoutubeDL instance with our defaults + private cookies (used by the photo engine)."""
    logger = logger or CollectLogger()
    with private_cookies(platform) as cookiefile:
        opts = base_opts(platform, logger)
        opts.update({"skip_download": True, **extra})
        if cookiefile:
            opts["cookiefile"] = cookiefile
        with yt_dlp.YoutubeDL(opts) as ydl:
            yield ydl


# ---------------------------------------------------------------------------- Instagram (photos)
class MGInstagramIE(InstagramIE):
    """Instagram extractor that also keeps the raw post data, so photos and carousels can be offered
    (yt-dlp itself only returns the video parts of a post)."""

    _mg_product: dict | None = None

    def _extract_product(self, product_info, video_id=None, get_comments=True):
        try:
            self._mg_product = product_info[0] if isinstance(product_info, list) else product_info
        except Exception:  # noqa: BLE001
            pass
        return super()._extract_product(product_info, video_id=video_id, get_comments=get_comments)


def _slim_ig_media(m: dict) -> dict:
    cands = ((m.get("image_versions2") or {}).get("candidates") or [])
    vids = m.get("video_versions") or []
    return {
        "media_type": m.get("media_type"),
        "code": m.get("code"),
        "pk": str(m.get("pk") or m.get("id") or ""),
        "original_width": m.get("original_width"),
        "original_height": m.get("original_height"),
        "images": [{"url": c.get("url"), "width": c.get("width"), "height": c.get("height")}
                   for c in cands if isinstance(c, dict) and c.get("url")],
        "videos": [{"url": v.get("url"), "width": v.get("width"), "height": v.get("height")}
                   for v in vids if isinstance(v, dict) and v.get("url")],
        "duration": m.get("video_duration"),
        "accessibility": m.get("accessibility_caption"),
    }


def _slim_ig_product(p: dict) -> dict:
    out = _slim_ig_media(p)
    out["carousel"] = [_slim_ig_media(c) for c in (p.get("carousel_media") or []) if isinstance(c, dict)]
    user = p.get("user") or {}
    out["username"] = user.get("username")
    out["full_name"] = user.get("full_name")
    out["caption"] = ((p.get("caption") or {}).get("text") or "")[:2000]
    out["taken_at"] = p.get("taken_at")
    return out


# ---------------------------------------------------------------------------- info extraction
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


def _note_cookie_health(platform: str, logger: CollectLogger) -> None:
    text = " ".join(logger.warnings).lower()
    if "cookies are no longer valid" in text or "cookies have likely been rotated" in text:
        monitor.notice(f"{platform}_cookies", "warning",
                       f"The {platform} cookies are no longer valid (rotated or logged out) — export fresh ones.")


def extract_info(url: str, playlist: bool = False) -> dict:
    """Extract metadata (no download). YouTube: retries other player clients and cookie-less mode."""
    platform = detect_platform(url)
    use_ig = platform == "instagram" and MGInstagramIE.suitable(url)
    last_error, details = "", []
    network_retry_done = extra_done = False
    best: dict | None = None
    attempts = youtube_attempts(platform)
    i = 0
    while i < len(attempts):
        att = attempts[i]
        logger = CollectLogger()
        info: dict | None = None
        product = None
        with private_cookies(platform, enabled=att.cookies) as cookiefile:
            opts = base_opts(platform, logger, att.clients)
            opts.update({
                "skip_download": True,
                "noplaylist": not playlist,
                "extract_flat": "in_playlist",
                "playlistend": settings.max_playlist_items,
            })
            if use_ig:
                opts["ignore_no_formats_error"] = True  # photo posts have no formats — we still want the data
            if cookiefile:
                opts["cookiefile"] = cookiefile
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    if use_ig:
                        ie = MGInstagramIE()
                        ydl.add_info_extractor(ie)
                        info = ydl.extract_info(url, download=False, ie_key=ie.ie_key())
                        product = ie._mg_product
                    else:
                        info = ydl.extract_info(url, download=False)
                    info = ydl.sanitize_info(info)
            except DownloadError as e:
                last_error, details = str(e), logger.details()
            except Exception as e:  # extractor crash
                last_error, details = f"{type(e).__name__}: {e}", logger.details()
        _note_cookie_health(platform, logger)
        if info:
            info["_mg_platform"] = platform
            info["_mg_clients"] = att.clients
            info["_mg_cookies"] = att.cookies
            if product:
                info["_mg_ig"] = _slim_ig_product(product)
            hidden = platform == "youtube" and info.get("_type") != "playlist" and formats_hidden(logger)
            info["_mg_hidden"] = hidden
            if best is None or max_video_height(info) > max_video_height(best):
                best = info
            # YouTube withheld formats from this client set → one extra attempt with the next set,
            # keep whichever result offers the highest genuine resolution
            if hidden and not extra_done and i + 1 < len(attempts):
                extra_done = True
                i += 1
                continue
            monitor.result("info", platform, True)
            return _slim_info(best)
        if best is not None:  # the extra attempt failed — the earlier result is still good
            monitor.result("info", platform, True)
            return _slim_info(best)
        code, _ = humanize_error(last_error)
        if code == "network" and not network_retry_done:
            network_retry_done = True
            time.sleep(1.5)
            continue  # same attempt once more
        if platform == "youtube" and is_youtube_retryable(last_error):
            i += 1
            continue
        break
    code, msg = humanize_error(last_error or "No media found")
    monitor.result("info", platform, False)
    monitor.error("info", platform, code, msg, url, details + [last_error[:300]])
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

    def __len__(self) -> int:
        return len(self._data)


info_cache = InfoCache(settings.info_cache_ttl)
gallery_cache = InfoCache(settings.info_cache_ttl, max_items=60)
