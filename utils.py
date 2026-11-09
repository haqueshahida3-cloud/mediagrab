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


def proxied_image(url: str | None, name: str | None = None, download: bool = False) -> str | None:
    """Return a signed same-origin URL that proxies a remote thumbnail (avoids CORP/hotlink blocks)."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    params = {"u": url, "s": sign(url)}
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
