"""Turn raw yt-dlp info dicts into a compact, UI-friendly structure."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from .config import settings
from .utils import detect_platform, proxied_image, clean_title
from .ytdl import POPULAR_SUB_LANGS

AUDIO_PRESETS: dict[str, dict] = {
    "mp3-320": {"codec": "mp3", "kbps": 320, "label": "MP3", "quality": "320 kbps", "tag": "320kbps", "popular": True},
    "mp3-256": {"codec": "mp3", "kbps": 256, "label": "MP3", "quality": "256 kbps", "tag": "256kbps"},
    "mp3-192": {"codec": "mp3", "kbps": 192, "label": "MP3", "quality": "192 kbps", "tag": "192kbps"},
    "mp3-128": {"codec": "mp3", "kbps": 128, "label": "MP3", "quality": "128 kbps", "tag": "128kbps"},
    "m4a": {"codec": "m4a", "kbps": None, "label": "M4A", "quality": "AAC · original", "tag": "M4A"},
    "opus": {"codec": "opus", "kbps": None, "label": "OPUS", "quality": "original", "tag": "OPUS"},
    "flac": {"codec": "flac", "kbps": None, "label": "FLAC", "quality": "lossless", "tag": "FLAC"},
    "wav": {"codec": "wav", "kbps": None, "label": "WAV", "quality": "uncompressed", "tag": "WAV"},
}

_STD_CLASSES = [(7680, 4320), (3840, 2160), (2560, 1440), (1920, 1080), (1280, 720), (854, 480), (640, 360), (426, 240), (256, 144)]


def codec_name(vcodec: str | None) -> str:
    v = (vcodec or "").lower()
    if v.startswith(("avc", "h264")):
        return "H.264"
    if v.startswith(("hev", "hvc", "h265", "bytevc1")):
        return "H.265"
    if v.startswith(("vp09", "vp9")):
        return "VP9"
    if v.startswith("av01"):
        return "AV1"
    if v.startswith("vp8"):
        return "VP8"
    return ""


def quality_badge(res: int) -> str:
    if res >= 4320:
        return "8K"
    if res >= 2160:
        return "4K"
    if res >= 1440:
        return "2K"
    if res >= 1080:
        return "FHD"
    if res >= 720:
        return "HD"
    return "SD"


def display_res(w: int | None, h: int | None) -> int:
    """Human resolution class: 1920x804 -> 1080, 1080x1920 -> 1080, 728x720 -> 720."""
    if not (w and h):
        return int(h or w or 0)
    short, long_ = min(w, h), max(w, h)
    by_long = next((cls for edge, cls in _STD_CLASSES if long_ >= edge * 0.95), short)
    return int(max(short, by_long))


def est_size(fmt: dict | None, duration: float | None) -> int:
    if not fmt:
        return 0
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    if size:
        return int(size)
    tbr = fmt.get("tbr")
    if tbr and duration:
        return int(tbr * 1000 / 8 * duration)
    return 0


def _audio_formats(formats: list[dict]) -> list[dict]:
    return [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") != "none"]


def _best_audio(formats: list[dict]) -> dict | None:
    """Best stereo audio track (mirrors the `channels:2` preference used for downloads)."""
    audios = _audio_formats(formats)
    return max(
        audios,
        key=lambda f: ((f.get("audio_channels") or 2) <= 2, "drc" not in str(f.get("format_id", "")).lower(),
                       f.get("abr") or f.get("tbr") or 0),
        default=None,
    )


def video_options(info: dict) -> list[dict]:
    formats = info.get("formats") or []
    duration = info.get("duration") or 0
    best_audio = _best_audio(formats)
    audio_size = est_size(best_audio, duration)

    groups: dict[int, list[dict]] = {}
    for f in formats:
        if f.get("vcodec") == "none":
            continue
        w, h = f.get("width"), f.get("height")
        if not (w or h):
            continue
        sort_res = int(min(w, h) if (w and h) else (h or w))
        if sort_res < 120:
            continue
        groups.setdefault(sort_res, []).append(f)

    def pref(f: dict) -> tuple:
        vc = (f.get("vcodec") or "").lower()
        proto = f.get("protocol") or ""
        return (vc.startswith(("avc", "h264")), "m3u8" not in proto, f.get("tbr") or 0)

    options: dict[int, dict] = {}
    for sort_res, fl in groups.items():
        rep = max(fl, key=pref)
        fps = max(int(f.get("fps") or 0) for f in fl)
        res = display_res(rep.get("width"), rep.get("height"))
        size = est_size(rep, duration)
        if size and rep.get("acodec") == "none" and audio_size:
            size += audio_size
        codecs = sorted({codec_name(f.get("vcodec")) for f in fl} - {""})
        hdr = any((f.get("dynamic_range") or "SDR") not in ("SDR",) for f in fl)
        opt = {
            "id": str(sort_res),
            "res": res,
            "label": f"{res}p" + (str(fps) if fps > 30 else ""),
            "badge": quality_badge(res),
            "fps": fps or None,
            "ext": "mp4",
            "size": size or None,
            "codec": codec_name(rep.get("vcodec")) or (codecs[0] if codecs else ""),
            "codecs": codecs,
            "hdr": hdr,
            "width": rep.get("width"),
            "height": rep.get("height"),
            "original": f"{rep.get('width')}×{rep.get('height')}" if rep.get("width") and rep.get("height") else None,
            "vcodec": rep.get("vcodec"),
            "has_audio": rep.get("acodec") not in (None, "none"),
        }
        # Two groups can map to the same label (e.g. 1920x800 & 1920x804) – keep the bigger one
        prev = options.get(res)
        if not prev or int(prev["id"]) < sort_res:
            options[res] = opt

    result = sorted(options.values(), key=lambda o: o["res"], reverse=True)
    if not result and any(f.get("vcodec") != "none" for f in formats):
        best = max(formats, key=lambda f: f.get("tbr") or 0)
        result.append({
            "id": "best", "res": 0, "label": "Best", "badge": "HD", "fps": None, "ext": "mp4",
            "size": est_size(best, duration) or None, "codec": codec_name(best.get("vcodec")),
            "codecs": [], "hdr": False, "width": None, "height": None,
        })
    return result


def audio_options(info: dict) -> list[dict]:
    formats = info.get("formats") or []
    if formats and all(f.get("acodec") == "none" for f in formats):
        return []  # silent video (e.g. GIF-like posts)
    duration = info.get("duration") or 0
    best = _best_audio(formats)
    best_size = est_size(best, duration)
    src_kbps = int((best or {}).get("abr") or (best or {}).get("tbr") or 0)
    out = []
    for pid, p in AUDIO_PRESETS.items():
        if p["kbps"]:
            size = int(p["kbps"] * 1000 / 8 * duration) if duration else None
        elif p["codec"] == "wav":
            size = int(1411 * 1000 / 8 * duration) if duration else None
        elif p["codec"] == "flac":
            size = int(850 * 1000 / 8 * duration) if duration else None
        else:
            size = best_size or (int(128000 / 8 * duration) if duration else None)
        quality = p["quality"]
        if p["codec"] in ("m4a", "opus") and src_kbps:
            quality = f"{quality} · ~{src_kbps} kbps"
        tier = "kbps" if p["kbps"] else {"flac": "lossless", "wav": "uncompressed"}.get(p["codec"], "original")
        out.append({
            "id": pid, "label": p["label"], "quality": quality, "ext": p["codec"], "tier": tier,
            "kbps": p["kbps"], "src_kbps": src_kbps or None,
            "size": size or None, "popular": bool(p.get("popular")),
        })
    return out


def thumbnail_options(info: dict, title: str) -> list[dict]:
    thumbs = [t for t in (info.get("thumbnails") or []) if t.get("url")]
    name = clean_title(title, 90)

    def score(t: dict) -> tuple:
        url = t["url"]
        is_jpg = not (".webp" in url or "vi_webp" in url)
        return ((t.get("width") or 0) * (t.get("height") or 0), is_jpg, t.get("preference") or 0)

    out, seen = [], set()
    for t in sorted(thumbs, key=score, reverse=True):
        w, h = t.get("width"), t.get("height")
        key = (w, h) if (w and h) else t["url"]
        if key in seen:
            continue
        seen.add(key)
        label = f"{w}×{h}" if (w and h) else "Original"
        same = sum(1 for o in out if o["label"].startswith(label))
        if same:
            label = f"{label} {same + 1}"
        out.append({
            "label": label,
            "width": w,
            "height": h,
            "url": proxied_image(t["url"]),
            "download": proxied_image(t["url"], f"{name} - thumbnail {label.replace('×', 'x')}", download=True),
        })
        if len(out) >= 4:
            break
    if not out and info.get("thumbnail"):
        out.append({
            "label": "Original", "width": None, "height": None,
            "url": proxied_image(info["thumbnail"]),
            "download": proxied_image(info["thumbnail"], f"{name} - thumbnail", download=True),
        })
    return out


def _track_name(tracks: list[dict], fallback: str) -> str:
    return next((t.get("name") for t in tracks if t.get("name")), fallback)


def subtitle_options(info: dict) -> list[dict]:
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    out = []
    for lang, tracks in subs.items():
        if lang in ("live_chat", "rechat", "danmaku"):
            continue
        out.append({"lang": lang, "name": _track_name(tracks, lang), "auto": False})
    manual = {s["lang"].split("-")[0] for s in out}
    for lang, tracks in autos.items():
        if lang.endswith("-orig") and lang[:-5] not in manual:
            out.append({"lang": lang, "name": _track_name(tracks, lang[:-5]), "auto": True})
    for lang in POPULAR_SUB_LANGS:
        if lang in autos and lang not in manual and f"{lang}-orig" not in autos:
            out.append({"lang": lang, "name": _track_name(autos[lang], lang), "auto": True, "translated": True})
    return out[:40]


def _playlist_hint(url: str, platform: str) -> str | None:
    if platform != "youtube":
        return None
    qs = parse_qs(urlparse(url).query)
    lst = (qs.get("list") or [None])[0]
    if lst and not lst.startswith(("RD", "UL")):  # skip auto-generated mixes
        return f"https://www.youtube.com/playlist?list={lst}"
    return None


def nice_title(info: dict) -> str:
    title = (info.get("title") or info.get("fulltitle") or "").strip()
    desc = (info.get("description") or "").strip()
    generic = (not title) or title.lower().startswith(("video by ", "post by ")) or title.lower() in ("instagram", "facebook", "video")
    if generic and desc:
        first = desc.splitlines()[0].strip()
        if first:
            return first[:140]
    return title or "Untitled"


def build_single(info: dict, source_url: str) -> dict:
    platform = info.get("_mg_platform") or detect_platform(info.get("webpage_url") or source_url)
    title = nice_title(info)
    duration = info.get("duration")
    d = info.get("upload_date")
    live_status = info.get("live_status")
    vopts = video_options(info)
    aopts = audio_options(info)
    max_res = max((o["res"] for o in vopts), default=0)
    return {
        "type": "video",
        "media_type": "video" if vopts else ("audio" if aopts else "video"),
        "max_res": max_res or None,
        "max_badge": quality_badge(max_res) if max_res else None,
        "formats_hidden": bool(info.get("_mg_hidden")),
        "id": info.get("id"),
        "platform": platform,
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "url": source_url,
        "webpage_url": info.get("webpage_url") or source_url,
        "title": title,
        "description": (info.get("description") or "")[:1500],
        "uploader": info.get("uploader") or info.get("channel") or info.get("creator") or info.get("uploader_id"),
        "uploader_url": info.get("uploader_url") or info.get("channel_url"),
        "verified": bool(info.get("channel_is_verified")),
        "thumbnail": proxied_image(info.get("thumbnail")),
        "duration": duration,
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "upload_date": f"{d[:4]}-{d[4:6]}-{d[6:8]}" if d and len(d) == 8 else None,
        "is_live": bool(info.get("is_live")) or live_status in ("is_live", "is_upcoming"),
        "age_limit": info.get("age_limit") or 0,
        "video": vopts,
        "audio": aopts,
        "thumbnails": thumbnail_options(info, title),
        "subtitles": subtitle_options(info),
        "chapters": [
            {"title": c.get("title") or f"Chapter {i + 1}", "start": c.get("start_time"), "end": c.get("end_time")}
            for i, c in enumerate(info.get("chapters") or [])
        ][:100],
        "sponsorblock": platform == "youtube",
        "playlist_url": _playlist_hint(source_url, platform),
        "too_long": bool(settings.max_duration_minutes and duration and duration > settings.max_duration_minutes * 60),
    }


def build_playlist(info: dict, source_url: str) -> dict:
    platform = info.get("_mg_platform") or detect_platform(source_url)
    entries = [e for e in (info.get("entries") or []) if e]
    items = []
    src = source_url.rstrip("/")
    for i, e in enumerate(entries[: settings.max_playlist_items], start=1):
        url = e.get("webpage_url") or e.get("url")
        own = url if (url and str(url).startswith("http") and str(url).rstrip("/") != src) else None
        thumbs = e.get("thumbnails") or []
        thumb = e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else None)
        items.append({
            "index": i,
            "id": e.get("id"),
            "title": nice_title(e) if e.get("title") or e.get("description") else f"Item {i}",
            "url": own,
            "duration": e.get("duration"),
            "thumbnail": proxied_image(thumb),
            "uploader": e.get("uploader") or e.get("channel"),
            "nested": e.get("_type") == "playlist" or str(e.get("ie_key") or "").endswith("Tab"),
        })
    first_thumb = next((it["thumbnail"] for it in items if it["thumbnail"]), None)
    return {
        "type": "playlist",
        "media_type": "playlist",
        "id": info.get("id"),
        "platform": platform,
        "url": source_url,
        "title": info.get("title") or "Playlist",
        "uploader": info.get("uploader") or info.get("channel"),
        "thumbnail": proxied_image(info.get("thumbnail")) or first_thumb,
        "count": info.get("playlist_count") or len(entries),
        "shown": len(items),
        "entries": items,
    }


def build_response(info: dict, source_url: str) -> dict:
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        if len(entries) == 1 and entries[0].get("formats"):
            single = dict(entries[0])
            single.setdefault("_mg_platform", info.get("_mg_platform"))
            return build_single(single, source_url)
        return build_playlist(info, source_url)
    return build_single(info, source_url)


def build_gallery(g: dict, source_url: str) -> dict:
    """Photo / carousel / album / mixed post → UI structure (media URLs only as signed previews)."""
    items = []
    for it in g["items"]:
        w, h = it.get("width"), it.get("height")
        items.append({
            "index": it["index"],
            "type": it["type"],
            "width": w,
            "height": h,
            "label": f"{w}×{h}" if (w and h) else None,
            "ext": it.get("ext"),
            "duration": it.get("duration"),
            "title": it.get("title"),
            "alt": it.get("alt"),
            "preview": proxied_image(it.get("preview"), width=480),
            "full": proxied_image(it.get("preview"), width=1080) if it["type"] == "image" else None,
        })
    counts = {k: sum(1 for i in items if i["type"] == k) for k in ("image", "video", "audio")}
    cover = next((i["preview"] for i in items if i["preview"]), None)
    return {
        "type": "gallery",
        "media_type": g["media_type"],
        "platform": g["platform"],
        "id": g.get("id"),
        "url": source_url,
        "title": g.get("title") or "Untitled",
        "description": g.get("description") or "",
        "uploader": g.get("uploader"),
        "uploader_url": g.get("uploader_url"),
        "upload_date": g.get("upload_date"),
        "thumbnail": cover,
        "count": len(items),
        "counts": counts,
        "items": items,
        "note": g.get("note"),
        "total": g.get("total"),
    }


def build_any(result: dict, source_url: str) -> dict:
    if result.get("gallery"):
        return build_gallery(result["gallery"], source_url)
    return build_response(result["raw"], source_url)
