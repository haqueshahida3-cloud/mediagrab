"""Photo engine: photos, carousels and albums (Instagram, TikTok photo mode, Facebook, X) + mixed posts.

Every extractor returns a *gallery* dict:

    {platform, id, url, title, description, uploader, uploader_url, upload_date, media_type,
     items: [{index, type: image|video|audio, url, width, height, ext, duration, preview}], referer, note}

Media URLs never leave the server unsigned: the API exposes previews through the signed thumbnail proxy and
downloads go through background jobs that fetch the original files (original bytes = original quality/format).
"""
from __future__ import annotations

import html as htmllib
import io
import json
import re
import time
import zipfile
from datetime import datetime, timezone
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx

from .config import settings
from .monitor import monitor
from .utils import clean_title, detect_platform, ext_from_content_type, is_public_http_url, sniff_media
from .ytdl import CollectLogger, MediaError, _cookie_source, has_cookies, humanize_error, ydl_session

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/141.0.0.0 Safari/537.36"
)
REFERERS = {
    "instagram": "https://www.instagram.com/",
    "facebook": "https://www.facebook.com/",
    "tiktok": "https://www.tiktok.com/",
    "twitter": "https://x.com/",
}
# Ask CDNs for the stored original instead of a re-encoded WebP/AVIF variant
MEDIA_ACCEPT = "image/jpeg,image/png,image/gif,image/*;q=0.8,video/*;q=0.8,audio/*;q=0.8,*/*;q=0.5"


def _ext_from_url(url: str, default: str = "jpg") -> str:
    q = parse_qs(urlparse(url).query)
    fmt = (q.get("format") or [""])[0].lower()
    if fmt in ("jpg", "jpeg", "png", "webp", "gif"):
        return "jpg" if fmt == "jpeg" else fmt
    path = urlparse(url).path.lower()
    m = re.search(r"\.(jpe?g|png|webp|gif|heic|avif|mp4|mov|webm|mp3|m4a)(?:$|[~?])", path)
    if m:
        return {"jpeg": "jpg"}.get(m.group(1), m.group(1))
    if "photomode-image.jpeg" in path or "image.jpeg" in path:
        return "jpg"
    return default


def _date(ts) -> str | None:
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return None


def _media_type(items: list[dict], album: bool = False) -> str:
    kinds = {i["type"] for i in items if i["type"] != "audio"}
    if kinds == {"image"}:
        if album:
            return "album"
        return "photo" if len([i for i in items if i["type"] == "image"]) == 1 else "carousel"
    if "image" in kinds:
        return "mixed"
    return "carousel" if len(items) > 1 else "video"


def _finish(g: dict) -> dict:
    items = [i for i in g["items"] if i.get("url")][: settings.max_gallery_items]
    for n, it in enumerate(items, start=1):
        it["index"] = n
        it.setdefault("ext", _ext_from_url(it["url"], "mp4" if it["type"] == "video" else "jpg"))
        it.setdefault("preview", it["url"] if it["type"] == "image" else None)
    g["items"] = items
    g["media_type"] = _media_type(items, album=g.pop("_album", False))
    g.setdefault("referer", REFERERS.get(g["platform"]))
    return g


# ---------------------------------------------------------------------------- Instagram
def _ig_best_image(m: dict) -> dict | None:
    imgs = [i for i in (m.get("images") or []) if i.get("url")]
    if not imgs:
        return None
    best = max(imgs, key=lambda i: (i.get("width") or 0) * (i.get("height") or 0))
    return best


def _ig_item(m: dict) -> dict | None:
    if m.get("media_type") == 2 or m.get("videos"):
        vids = m.get("videos") or []
        if not vids:
            return None
        best = max(vids, key=lambda v: (v.get("width") or 0) * (v.get("height") or 0))
        cover = _ig_best_image(m)
        return {"type": "video", "url": best["url"], "width": best.get("width"), "height": best.get("height"),
                "ext": "mp4", "duration": m.get("duration"), "preview": cover["url"] if cover else None}
    best = _ig_best_image(m)
    if not best:
        return None
    return {"type": "image", "url": best["url"], "width": best.get("width") or m.get("original_width"),
            "height": best.get("height") or m.get("original_height"), "ext": _ext_from_url(best["url"]),
            "alt": m.get("accessibility")}


def from_instagram(info: dict, source_url: str) -> dict | None:
    """Gallery for Instagram photo posts / carousels. Single-video posts return None (normal video flow)."""
    p = info.get("_mg_ig")
    if not p:
        return None
    parts = p.get("carousel") or [p]
    items = [it for it in (_ig_item(m) for m in parts) if it]
    if not items or (len(items) == 1 and items[0]["type"] == "video"):
        return None
    caption = p.get("caption") or ""
    return _finish({
        "platform": "instagram",
        "id": p.get("code") or info.get("id"),
        "url": source_url,
        "title": caption.splitlines()[0][:140] if caption.strip() else f"Post by {p.get('username') or 'instagram'}",
        "description": caption[:1500],
        "uploader": p.get("username") or info.get("channel"),
        "uploader_url": f"https://www.instagram.com/{p['username']}/" if p.get("username") else None,
        "upload_date": _date(p.get("taken_at")),
        "items": items,
    })


# ---------------------------------------------------------------------------- TikTok photo mode
_TT_ID = re.compile(r"/(?:photo|video)/(\d{8,})")


def tiktok_video_url(url: str) -> str:
    """yt-dlp and TikTok's web data only work with /video/ links — photo posts use /photo/."""
    return re.sub(r"/photo/(\d+)", r"/video/\1", url, count=1)


def resolve_short_tiktok(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if host not in ("vm.tiktok.com", "vt.tiktok.com") and not urlparse(url).path.startswith("/t/"):
        return url
    try:
        with httpx.Client(follow_redirects=True, timeout=15, headers={"User-Agent": BROWSER_UA},
                          proxy=settings.proxy or None) as c:
            r = c.head(url)
            final = str(r.url)
    except httpx.HTTPError:
        return url
    return final if detect_platform(final) == "tiktok" else url


def tiktok_photo(url: str) -> dict | None:
    m = _TT_ID.search(urlparse(url).path)
    if not m:
        return None
    post_id = m.group(1)
    logger = CollectLogger()
    try:
        with ydl_session("tiktok", logger) as ydl:
            ie = ydl.get_info_extractor("TikTok")
            data, status = ie._extract_web_data_and_status(tiktok_video_url(url), post_id)
    except Exception as e:  # noqa: BLE001
        code, msg = humanize_error(str(e))
        if code in ("unavailable", "private", "login_required", "geo_blocked"):
            raise MediaError(msg, code) from None
        return None
    if status in (10216, 10222):
        raise MediaError("This TikTok post is private.", "private")
    images = ((data or {}).get("imagePost") or {}).get("images") or []
    if not images:
        return None
    items = []
    for im in images:
        urls = (im.get("imageURL") or {}).get("urlList") or []
        if not urls:
            continue
        best = next((u for u in urls if ".jpeg" in u or ".jpg" in u), urls[0])
        items.append({"type": "image", "url": best, "width": im.get("imageWidth"), "height": im.get("imageHeight"),
                      "ext": _ext_from_url(best)})
    music = data.get("music") or {}
    if music.get("playUrl"):
        items.append({"type": "audio", "url": music["playUrl"], "ext": _ext_from_url(music["playUrl"], "mp3"),
                      "duration": music.get("duration"), "title": music.get("title"),
                      "preview": music.get("coverLarge") or music.get("coverMedium")})
    author = data.get("author") or {}
    desc = (data.get("desc") or "").strip()
    return _finish({
        "platform": "tiktok",
        "id": post_id,
        "url": url,
        "title": desc.splitlines()[0][:140] if desc else f"Photos by @{author.get('uniqueId') or 'tiktok'}",
        "description": desc[:1500],
        "uploader": author.get("uniqueId") or author.get("nickname"),
        "uploader_url": f"https://www.tiktok.com/@{author['uniqueId']}" if author.get("uniqueId") else None,
        "upload_date": _date(data.get("createTime")),
        "items": items,
    })


# ---------------------------------------------------------------------------- X / Twitter
_TW_ID = re.compile(r"/status(?:es)?/(\d{6,})")


def _tw_orig(url: str) -> str:
    """https://pbs.twimg.com/media/ABC.jpg → https://pbs.twimg.com/media/ABC?format=jpg&name=orig"""
    m = re.match(r"(https://pbs\.twimg\.com/media/[\w-]+)\.(jpg|jpeg|png|webp|gif)", url)
    if m:
        return f"{m.group(1)}?format={m.group(2).replace('jpeg', 'jpg')}&name=orig"
    return url


def twitter_media(url: str) -> dict | None:
    """Photos (and mixed photo+video posts) via the syndication API. Video-only posts → None (yt-dlp flow)."""
    m = _TW_ID.search(urlparse(url).path)
    if not m:
        return None
    try:
        with ydl_session("twitter") as ydl:
            status = ydl.get_info_extractor("Twitter")._call_syndication_api(m.group(1))
    except Exception:  # noqa: BLE001 — fall back to yt-dlp's own extraction
        return None
    media = status.get("mediaDetails") or []
    if not any(md.get("type") == "photo" for md in media):
        return None
    items = []
    for md in media:
        oi = md.get("original_info") or {}
        if md.get("type") == "photo" and md.get("media_url_https"):
            items.append({"type": "image", "url": _tw_orig(md["media_url_https"]), "width": oi.get("width"),
                          "height": oi.get("height"), "ext": _ext_from_url(md["media_url_https"])})
        elif md.get("type") in ("video", "animated_gif"):
            variants = [v for v in ((md.get("video_info") or {}).get("variants") or [])
                        if v.get("content_type") == "video/mp4" and v.get("url")]
            if variants:
                best = max(variants, key=lambda v: v.get("bitrate") or 0)
                dur = ((md.get("video_info") or {}).get("duration_millis") or 0) / 1000 or None
                items.append({"type": "video", "url": best["url"], "width": oi.get("width"), "height": oi.get("height"),
                              "ext": "mp4", "duration": dur, "preview": md.get("media_url_https")})
    user = status.get("user") or {}
    text = re.sub(r"\s*https://t\.co/\w+\s*$", "", status.get("text") or "").strip()
    return _finish({
        "platform": "twitter",
        "id": m.group(1),
        "url": url,
        "title": text.splitlines()[0][:140] if text else f"Post by @{user.get('screen_name') or 'x'}",
        "description": text[:1500],
        "uploader": user.get("screen_name") or user.get("name"),
        "uploader_url": f"https://x.com/{user['screen_name']}" if user.get("screen_name") else None,
        "upload_date": (status.get("created_at") or "")[:10] or None,
        "items": items,
    })


# ---------------------------------------------------------------------------- Facebook
FB_PHOTO_RE = re.compile(r"/photo(?:\.php)?/?(?:\?|$)|/photos/|/media/set/|/posts/|/permalink\.php|/story\.php|"
                         r"/share/p/|/albums?/|/photo/\?", re.I)
FB_ALBUM_RE = re.compile(r"/media/set/|/photos/a\.|/albums?/|[?&]set=a\.", re.I)


def is_facebook_photo_url(url: str) -> bool:
    return bool(FB_PHOTO_RE.search(urlparse(url).path + ("?" + urlparse(url).query if urlparse(url).query else "")))


def _curl_session(platform: str):
    from curl_cffi import requests as creq

    s = creq.Session(impersonate="chrome")
    if settings.proxy:
        s.proxies = {"http": settings.proxy, "https": settings.proxy}
    src = _cookie_source(platform)
    if src:
        jar = MozillaCookieJar()
        try:
            jar.load(str(src), ignore_discard=True, ignore_expires=True)
            for c in jar:
                s.cookies.set(c.name, c.value, domain=c.domain, path=c.path)
        except (OSError, ValueError):
            pass
    return s


def _fb_gallery_dl(url: str) -> list[dict]:
    """Logged-in Facebook extraction through gallery-dl (only used when facebook cookies are configured)."""
    try:
        from gallery_dl import config as gconfig, job as gjob
    except ImportError:
        return []
    src = _cookie_source("facebook")
    gconfig.clear()
    gconfig.set(("extractor",), "cookies", str(src) if src else None)
    gconfig.set(("extractor",), "user-agent", BROWSER_UA)
    if settings.proxy:
        gconfig.set(("extractor",), "proxy", settings.proxy)
    gconfig.set(("extractor", "facebook"), "videos", False)
    j = gjob.DataJob(url, file=io.StringIO())
    j.run()
    items = []
    for msg in j.data:
        if msg and msg[0] == 3 and len(msg) >= 3:  # Message.Url
            kw = msg[2] or {}
            items.append({"type": "image", "url": msg[1], "width": kw.get("width"), "height": kw.get("height"),
                          "ext": kw.get("extension") or _ext_from_url(msg[1]),
                          "_meta": {"caption": kw.get("caption"), "username": kw.get("username"),
                                    "date": str(kw.get("date") or "")[:10]}})
        if len(items) >= settings.max_gallery_items:
            break
    return items


_JSON = json.JSONDecoder()


def _fb_image(media: dict) -> dict | None:
    for key in ("viewer_image", "photo_image", "image"):
        img = media.get(key) if isinstance(media, dict) else None
        if isinstance(img, dict) and img.get("uri"):
            return {"type": "image", "url": img["uri"], "width": img.get("width"), "height": img.get("height"),
                    "ext": _ext_from_url(img["uri"])}
    return None


def _fb_parse_page(page: str, album: bool) -> tuple[list[dict], int]:
    """Photos of a public Facebook post / album page → (items, total photos in the post)."""
    items: list[dict] = []
    seen: set[str] = set()

    def add(it: dict | None) -> None:
        if not it:
            return
        key = re.sub(r"\?.*$", "", it["url"]).rsplit("/", 1)[-1]
        if key not in seen:
            seen.add(key)
            items.append(it)

    # Multi-photo post: the post's own attachment list (other posts on the page are ignored)
    m = re.search(r'"all_subattachments":\{"count":(\d+),"nodes":', page)
    if m and not album:
        try:
            nodes, _ = _JSON.raw_decode(page, m.end())
            for node in nodes:
                add(_fb_image((node or {}).get("media") or {}))
        except ValueError:
            pass
        return items, int(m.group(1))
    # Single-photo post: the first Photo media object
    if not album:
        m = re.search(r'"media":(\{"__typename":"Photo")', page)
        if m:
            try:
                media, _ = _JSON.raw_decode(page, m.start(1))
                add(_fb_image(media))
            except ValueError:
                pass
            if items:
                return items, 1
    # Album / set page: every photo tile in the grid
    for vm in re.finditer(r'"viewer_image":\{"height":(\d+),"width":(\d+),"uri":"([^"]+)"\}', page):
        try:
            img = json.loads(f'"{vm.group(3)}"')
        except ValueError:
            continue
        add({"type": "image", "url": img, "width": int(vm.group(2)), "height": int(vm.group(1)),
             "ext": _ext_from_url(img)})
    if not items:
        og = re.search(r'<meta property="og:image" content="([^"]+)"', page)
        if og:
            add({"type": "image", "url": htmllib.unescape(og.group(1)), "ext": "jpg"})
    return items, 0


def facebook_media(url: str) -> dict | None:
    items: list[dict] = []
    meta: dict = {}
    if has_cookies("facebook"):
        try:
            items = _fb_gallery_dl(url)
        except Exception:  # noqa: BLE001
            items = []
        if items:
            meta = items[0].pop("_meta", {}) or {}
            for it in items[1:]:
                it.pop("_meta", None)
    if not items:
        s = _curl_session("facebook")
        try:
            r = s.get(url, timeout=25, headers={"Accept-Language": "en-US,en;q=0.9"})
        except Exception:  # noqa: BLE001
            raise MediaError("Facebook took too long to respond. Please try again.", "network") from None
        if "/login" in urlparse(str(r.url)).path or "/checkpoint" in str(r.url):
            raise MediaError(
                "Facebook only shows this photo to logged-in users. Public posts and albums work without login; "
                "for this one the server admin needs to add Facebook cookies.", "login_required")
        page = r.text
        items, total_photos = _fb_parse_page(page, album=bool(FB_ALBUM_RE.search(url)))
        if total_photos and total_photos > len(items):
            meta["partial"] = total_photos
        title = re.search(r'<meta property="og:title" content="([^"]*)"', page)
        desc = re.search(r'<meta property="og:description" content="([^"]*)"', page)
        meta.update({"caption": htmllib.unescape(desc.group(1)) if desc else "",
                     "username": htmllib.unescape(title.group(1)) if title else ""})
    if not items:
        return None
    caption = (meta.get("caption") or "").strip()
    pid = (parse_qs(urlparse(url).query).get("fbid") or [None])[0] or urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
    return _finish({
        "platform": "facebook",
        "id": pid[:64],
        "url": url,
        "title": caption.splitlines()[0][:140] if caption else (meta.get("username") or "Facebook photos"),
        "description": caption[:1500],
        "uploader": meta.get("username") or None,
        "uploader_url": None,
        "upload_date": meta.get("date") or None,
        "items": items,
        "_album": bool(FB_ALBUM_RE.search(url)),
        "note": "partial" if meta.get("partial") else None,
        "total": meta.get("partial") or None,
    })


# ---------------------------------------------------------------------------- generic (og:image)
def generic_images(url: str) -> dict | None:
    """Last resort for sites without a photo extractor: the page's preview image (og:image / twitter:image)."""
    try:
        with httpx.Client(follow_redirects=True, timeout=15, headers={"User-Agent": BROWSER_UA},
                          proxy=settings.proxy or None) as c:
            r = c.get(url)
    except httpx.HTTPError:
        return None
    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
        return None
    page = r.text[:600_000]
    found = re.findall(r'<meta[^>]+(?:property|name)="(?:og:image(?::secure_url)?|twitter:image(?::src)?)"[^>]+'
                       r'content="([^"]+)"', page)
    imgs = []
    for u in found:
        u = htmllib.unescape(u)
        if u.startswith("//"):
            u = "https:" + u
        if u.startswith("http") and u not in imgs:
            imgs.append(u)
    if not imgs:
        return None
    title = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]*)"', page)
    return _finish({
        "platform": detect_platform(url),
        "id": None,
        "url": url,
        "title": htmllib.unescape(title.group(1))[:140] if title else (urlparse(url).hostname or "Image"),
        "description": "",
        "uploader": urlparse(url).hostname,
        "uploader_url": None,
        "upload_date": None,
        "items": [{"type": "image", "url": u, "ext": _ext_from_url(u)} for u in imgs[:4]],
        "note": "preview_only",
    })


# ---------------------------------------------------------------------------- downloads
class StopDownload(Exception):
    """Raised by the cancel/pause callback to abort a transfer."""


def download_media(url: str, dest_stem: Path, referer: str | None, max_bytes: int,
                   on_progress: Callable[[int, int], None] | None = None,
                   should_stop: Callable[[], bool] | None = None, expect: str | None = None) -> Path:
    """Stream one remote media file to `dest_stem.<real ext>`; validates host, size and file type."""
    if not is_public_http_url(url):
        raise MediaError("This media address is not allowed.", "invalid_url")
    headers = {"User-Agent": BROWSER_UA, "Accept": MEDIA_ACCEPT}
    if referer:
        headers["Referer"] = referer
    part = dest_stem.with_suffix(".part")
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, connect=10.0), headers=headers,
                              proxy=settings.proxy or None) as client:
                resume = part.stat().st_size if part.exists() else 0
                req_headers = {"Range": f"bytes={resume}-"} if resume else {}
                with client.stream("GET", url, headers=req_headers) as r:
                    if r.status_code == 416:
                        resume, req_headers = 0, {}
                        part.unlink(missing_ok=True)
                        raise httpx.TransportError("range not satisfiable — restarting")
                    if r.status_code not in (200, 206):
                        raise MediaError(f"The platform refused the file (HTTP {r.status_code}).",
                                         "forbidden" if r.status_code in (401, 403) else "unavailable")
                    if not is_public_http_url(str(r.url)):
                        raise MediaError("This media address is not allowed.", "invalid_url")
                    if r.status_code == 200 and resume:
                        resume = 0  # server ignored Range → start over
                    total = int(r.headers.get("content-length") or 0) + resume
                    if max_bytes and total > max_bytes:
                        raise MediaError("This file is larger than the server's download limit.", "too_large")
                    done = resume
                    with open(part, "ab" if resume else "wb") as fh:
                        for chunk in r.iter_bytes(256 * 1024):
                            if should_stop and should_stop():
                                raise StopDownload()
                            fh.write(chunk)
                            done += len(chunk)
                            if max_bytes and done > max_bytes:
                                raise MediaError("This file is larger than the server's download limit.", "too_large")
                            if on_progress:
                                on_progress(done, total)
                    ctype = r.headers.get("content-type", "")
            if total and part.stat().st_size < total:
                raise httpx.TransportError("incomplete transfer")
            with open(part, "rb") as fh:
                head = fh.read(64)
            sniffed = sniff_media(head)
            if not sniffed:
                part.unlink(missing_ok=True)
                raise MediaError("The platform returned a web page instead of the media file "
                                 "(it may require login or the link expired).", "forbidden")
            kind, ext = sniffed
            if expect and kind != expect and not (expect == "audio" and kind == "video"):
                ext = ext_from_content_type(ctype) or ext
            final = dest_stem.with_suffix("." + ext)
            part.replace(final)
            return final
        except (MediaError, StopDownload):
            raise
        except (httpx.HTTPError, OSError) as e:
            last_exc = e
            time.sleep(1.5 * (attempt + 1))
    raise MediaError("The download kept failing because of network errors. Please try again.", "network") \
        from last_exc


def build_zip(files: list[tuple[Path, str]], dest: Path, should_stop: Callable[[], bool] | None = None,
              on_progress: Callable[[int, int], None] | None = None) -> Path:
    """ZIP without recompression (photos/videos are already compressed) — fast and low-memory.
    `files` = [(path, name inside the zip)]."""
    total = sum(f.stat().st_size for f, _ in files) or 1
    done = 0
    tmp = dest.with_name(dest.name + ".part")
    used: set[str] = set()
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for f, arc in files:
            if should_stop and should_stop():
                raise StopDownload()
            stem, suffix = (arc.rsplit(".", 1) + [""])[:2]
            name, n = arc, 2
            while name.lower() in used:
                name = f"{stem} ({n}).{suffix}" if suffix else f"{stem} ({n})"
                n += 1
            used.add(name.lower())
            zf.write(f, arcname=name)
            done += f.stat().st_size
            if on_progress:
                on_progress(done, total)
    tmp.replace(dest)
    return dest


def item_filename(g: dict, item: dict, single: bool) -> str:
    who = clean_title(g.get("uploader") or g.get("platform") or "media", 40)
    what = clean_title(g.get("title") or g.get("id") or "post", 70)
    base = what if what.lower().startswith(who.lower()) else f"{who} - {what}"
    base = clean_title(base, 110)
    total = len([i for i in g["items"] if i["type"] != "audio"])
    if item["type"] == "audio":
        return f"{base} (sound)"
    return base if (single and total == 1) else f"{base} ({item['index']:02d} of {total:02d})"


def zip_name(g: dict, count: int) -> str:
    who = clean_title(g.get("uploader") or g.get("platform") or "media", 40)
    what = clean_title(g.get("title") or g.get("id") or "post", 70)
    base = what if what.lower().startswith(who.lower()) else f"{who} - {what}"
    return f"{clean_title(base, 110)} ({count} files).zip"


# ---------------------------------------------------------------------------- detection entry point
def find_gallery(url: str, platform: str, info: dict | None = None, *, after_error: bool = False) -> dict | None:
    """Return a gallery for photo/carousel/album/mixed posts, else None.

    `info` — yt-dlp info (Instagram keeps the raw post data there).  `after_error` — yt-dlp failed with
    "no video"/"unsupported": try photo extraction for platforms we know.
    """
    try:
        if platform == "instagram" and info:
            return from_instagram(info, url)
        if platform == "tiktok":
            return tiktok_photo(url)
        if platform == "twitter":
            return twitter_media(url)
        if platform == "facebook":
            return facebook_media(url)
        if after_error and platform not in ("youtube",):
            return generic_images(url)
    except MediaError:
        raise
    except Exception as e:  # noqa: BLE001 — photo detection must never break video downloads
        monitor.error("gallery", platform, "extractor_crash", f"{type(e).__name__}: {e}", url)
    return None


def public_url_for(url: str) -> str:
    """Strip tracking parameters for display/caching keys."""
    p = urlparse(url)
    q = {k: v for k, v in parse_qs(p.query).items()
         if not re.match(r"^(utm_|igsh|igshid|si$|fbclid|_r$|is_from_webapp|sender_device|_t$)", k)}
    return urlunparse(p._replace(query=urlencode(q, doseq=True)))
