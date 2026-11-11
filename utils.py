"""Helpers: platform detection, URL validation (SSRF-safe), filenames, signing."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import socket
import unicodedata
from urllib.parse import quote, urlencode, urlparse

from .config import settings

PLATFORM_HOSTS: dict[str, tuple[str, ...]] = {
    "youtube": ("youtube.com", "youtu.be", "youtube-nocookie.com"),
    "facebook": ("facebook.com", "fb.watch", "fb.com", "fb.me"),
    "instagram": ("instagram.com", "instagr.am"),
    "twitter": ("twitter.com", "x.com", "t.co"),
    "tiktok": ("tiktok.com",),
    "vimeo": ("vimeo.com",),
    "reddit": ("reddit.com", "redd.it"),
    "dailymotion": ("dailymotion.com", "dai.ly"),
    "soundcloud": ("soundcloud.com",),
    "pinterest": ("pinterest.com", "pin.it"),
    "threads": ("threads.net", "threads.com"),
    "twitch": ("twitch.tv",),
    "linkedin": ("linkedin.com",),
    "snapchat": ("snapchat.com",),
    "bilibili": ("bilibili.com", "bilibili.tv", "b23.tv"),
}

URL_RE = re.compile(r"https?://[^\s<>\"'`]+", re.IGNORECASE)
BARE_URL_RE = re.compile(r"^(?:www\.)?[\w-]+(?:\.[\w-]+)+/\S*$", re.IGNORECASE)


class InvalidURL(ValueError):
    pass


def detect_platform(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    for name, hosts in PLATFORM_HOSTS.items():
        for h in hosts:
            if host == h or host.endswith("." + h):
                return name
    return "other"


def extract_url(text: str) -> str | None:
    """Pull the first URL out of arbitrary (shared) text."""
    text = (text or "").strip()
    if not text:
        return None
    m = URL_RE.search(text)
    if m:
        return m.group(0).rstrip(".,;:!?)]}>")
    if BARE_URL_RE.match(text):
        return "https://" + text
    return None


def _is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


def validate_public_url(raw: str) -> str:
    """Normalise a user supplied URL and make sure it points to the public internet."""
    url = extract_url(raw)
    if not url or len(url) > 2048:
        raise InvalidURL("Please paste a valid video link (https://...)")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise InvalidURL("Only http(s) links are supported")
    host = parsed.hostname.lower()
    if host in {"localhost"} or host.endswith((".local", ".internal", ".localhost")):
        raise InvalidURL("This address is not allowed")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except (socket.gaierror, UnicodeError):
        raise InvalidURL("Could not resolve this website — check the link") from None
    if not infos or not all(_is_public_ip(info[4][0]) for info in infos):
        raise InvalidURL("This address is not allowed")
    return url


def is_public_http_url(url: str) -> bool:
    """True when `url` is http(s) and its host resolves only to public addresses (SSRF guard for media CDNs)."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        host = parsed.hostname.lower()
        if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
            return False
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except (OSError, UnicodeError, ValueError):
        return False
    return bool(infos) and all(_is_public_ip(info[4][0]) for info in infos)


_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


def clean_title(name: str, max_len: int = 120) -> str:
    name = unicodedata.normalize("NFC", name or "")
    name = _ILLEGAL.sub(" ", name)
    name = re.sub(r"\s+", " ", name).strip(" .-_")
    if len(name) > max_len:
        name = name[:max_len].rstrip(" .-_")
    return name or "media"


def content_disposition(filename: str, inline: bool = False) -> str:
    ascii_name = unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode()
    ascii_name = re.sub(r'[^\w\s.\-()\[\]]', "", ascii_name).strip() or "download"
    if "." not in ascii_name and "." in filename:
        ascii_name += "." + filename.rsplit(".", 1)[-1]
    disp = "inline" if inline else "attachment"
    return f"{disp}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}"


def sign(value: str) -> str:
    return hmac.new(settings.secret_key.encode(), value.encode(), hashlib.sha256).hexdigest()[:32]


def verify(value: str, signature: str) -> bool:
    return hmac.compare_digest(sign(value), signature or "")


def proxied_image(url: str | None, name: str | None = None, download: bool = False,
                  width: int | None = None) -> str | None:
    """Return a signed same-origin URL that proxies a remote image (avoids CORP/hotlink blocks).
    `width` asks the proxy for a resized preview (240/360/480/720/1080)."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    params = {"u": url, "s": sign(url)}
    if width and not download:
        params["w"] = str(width)
    if download:
        params["dl"] = "1"
        if name:
            params["name"] = name[:100]
    return "/api/thumb?" + urlencode(params)


def parse_timestamp(value: str | None) -> float | None:
    """Parse '90', '1:30', '01:02:03.5' into seconds."""
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        return None
    if not re.fullmatch(r"\d+(?::\d{1,2}){0,2}(?:\.\d+)?", value):
        raise ValueError(f"Invalid time: {value}")
    parts = value.split(":")
    seconds = 0.0
    for p in parts:
        seconds = seconds * 60 + float(p)
    return seconds


def fmt_ts(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


# ---------------------------------------------------------------------------- file types
_CTYPE_EXT = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/avif": "avif", "image/heic": "heic", "image/heif": "heic", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a",
    "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "weba", "audio/wav": "wav",
}


def ext_from_content_type(ctype: str | None) -> str | None:
    return _CTYPE_EXT.get((ctype or "").split(";")[0].strip().lower())


def sniff_media(head: bytes) -> tuple[str, str] | None:
    """Identify a file from its first bytes → (kind, ext). None = not a media file (e.g. an HTML error page)."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image", "webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio", "wav"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image", "gif"
    if head.startswith(b"BM"):
        return "image", "bmp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "image", "avif"
        if brand in (b"heic", b"heix", b"mif1", b"msf1", b"hevc", b"heim", b"heis"):
            return "image", "heic"
        if brand in (b"M4A ", b"M4B "):
            return "audio", "m4a"
        if brand == b"qt  ":
            return "video", "mov"
        return "video", "mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video", "webm"
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return "audio", "mp3"
    if head.startswith(b"OggS"):
        return "audio", "ogg"
    if head.startswith(b"fLaC"):
        return "audio", "flac"
    return None


def image_dimensions(path) -> tuple[int, int] | None:
    """Read width/height from a JPEG, PNG, GIF or WebP header (no image library needed)."""
    import struct
    try:
        with open(path, "rb") as fh:
            head = fh.read(32)
            if head.startswith(b"\x89PNG") and head[12:16] == b"IHDR":
                return struct.unpack(">II", head[16:24])
            if head[:6] in (b"GIF87a", b"GIF89a"):
                return struct.unpack("<HH", head[6:10])
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                chunk = head[12:16]
                if chunk == b"VP8X":
                    w = int.from_bytes(head[24:27], "little") + 1
                    h = int.from_bytes(fh.read(3), "little") + 1
                    return w, h
                if chunk == b"VP8 ":
                    fh.seek(26)
                    w, h = struct.unpack("<HH", fh.read(4))
                    return w & 0x3FFF, h & 0x3FFF
                if chunk == b"VP8L":
                    fh.seek(21)
                    b = fh.read(4)
                    w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                    h = 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                    return w, h
            if head[:2] == b"\xff\xd8":
                fh.seek(2)
                while True:
                    marker = fh.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    if marker[1] in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        fh.read(3)
                        h, w = struct.unpack(">HH", fh.read(4))
                        return w, h
                    seg_len = struct.unpack(">H", fh.read(2))[0]
                    fh.seek(seg_len - 2, 1)
    except (OSError, struct.error, IndexError):
        return None
    return None
