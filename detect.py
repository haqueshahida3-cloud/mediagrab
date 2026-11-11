"""Media detection engine: decides whether a link is a video, audio, playlist, photo, carousel, album or a
mixed post, and returns either yt-dlp info (`raw`) or a photo-engine gallery (`gallery`)."""
from __future__ import annotations

from urllib.parse import urlparse

from . import gallery as G
from .monitor import monitor
from .utils import detect_platform
from .ytdl import MediaError, extract_info, gallery_cache, info_cache

# yt-dlp errors after which the photo engine gets a chance
PHOTO_FALLBACK_CODES = {"no_video", "unsupported", "format_unavailable"}


def _remember(keys: list[str], result: dict) -> dict:
    for k in {k for k in keys if k}:
        if result.get("gallery"):
            gallery_cache.set(k, result["gallery"])
        elif result.get("raw") is not None and result["raw"].get("_type") != "playlist":
            info_cache.set(k, result["raw"])
    return result


def analyze(url: str, playlist: bool = False) -> dict:
    """Return {"raw": info} or {"gallery": gallery} (raises MediaError with a friendly message)."""
    platform = detect_platform(url)
    keys = [url]

    if not playlist:
        cached_gallery = gallery_cache.peek(url)
        if cached_gallery:
            return {"gallery": cached_gallery}
        cached = info_cache.peek(url)
        if cached:
            return {"raw": cached}

    deferred: MediaError | None = None

    if platform == "tiktok":
        resolved = G.resolve_short_tiktok(url)
        if resolved != url:
            keys.append(resolved)
        if "/photo/" in urlparse(resolved).path:
            g = G.tiktok_photo(resolved)
            if g:
                g["url"] = url
                return _remember(keys, {"gallery": g})
        url = G.tiktok_video_url(resolved)  # yt-dlp only understands /video/ links

    elif platform == "twitter" and not playlist and "/status" in urlparse(url).path:
        g = G.twitter_media(url)  # photos & mixed posts; video-only posts continue below
        if g:
            return _remember(keys, {"gallery": g})

    elif platform == "facebook" and G.is_facebook_photo_url(url):
        try:
            g = G.facebook_media(url)
            if g:
                return _remember(keys, {"gallery": g})
        except MediaError as e:
            deferred = e  # maybe it's a video post — let yt-dlp try first

    try:
        raw = extract_info(url, playlist)
    except MediaError as e:
        if deferred:
            raise deferred from None
        if e.code in PHOTO_FALLBACK_CODES and platform != "youtube":
            g = G.find_gallery(url, platform, after_error=True)
            if g:
                monitor.count("gallery.fallback")
                return _remember(keys, {"gallery": g})
        raise

    if platform == "instagram":
        g = G.from_instagram(raw, url)
        if g:
            return _remember(keys, {"gallery": g})
        if raw.get("_type") == "playlist" or not raw.get("formats"):
            # e.g. a post whose parts we couldn't read: fall back to whatever yt-dlp offers
            pass

    if platform == "tiktok" and not raw.get("formats") and raw.get("_type") != "playlist":
        g = G.tiktok_photo(url)
        if g:
            return _remember(keys, {"gallery": g})

    if raw.get("webpage_url") and raw["webpage_url"] != url:
        keys.append(raw["webpage_url"])
    return _remember(keys, {"raw": raw})


def get_gallery(url: str) -> dict:
    """Gallery for a download job: cached from /api/info, else re-detected."""
    g = gallery_cache.get(url)
    if g:
        return g
    result = analyze(url)
    if not result.get("gallery"):
        raise MediaError("No photos were found at this link.", "no_media")
    return result["gallery"]
