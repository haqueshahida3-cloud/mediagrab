"""Account (author) information shown next to a post: name, @handle, profile link, avatar, verified badge, followers.

Only data the platform already returned for the post is used. Nothing private is accessed and no extra request to the
platform is made. Anything a platform does not provide is simply left out (the card then shows what is available).
"""
from __future__ import annotations

import re
from urllib.parse import quote, urlparse

from .utils import proxied_image

# profile links must stay on the platform's own domains
PROFILE_HOSTS: dict[str, tuple[str, ...]] = {
    "youtube": ("youtube.com",),
    "instagram": ("instagram.com",),
    "facebook": ("facebook.com", "fb.com"),
    "twitter": ("x.com", "twitter.com"),
    "tiktok": ("tiktok.com",),
}
PROFILE_URL = {
    "youtube": "https://www.youtube.com/@{h}",
    "instagram": "https://www.instagram.com/{h}/",
    "facebook": "https://www.facebook.com/{h}",
    "twitter": "https://x.com/{h}",
    "tiktok": "https://www.tiktok.com/@{h}",
}
_HANDLE = re.compile(r"^[\w.\-]{1,60}$", re.UNICODE)
_URL_HANDLE = {
    "youtube": re.compile(r"/@([^/?#]+)"),
    "tiktok": re.compile(r"/@([^/?#]+)"),
    "instagram": re.compile(r"^/([A-Za-z0-9._]{1,30})/?$"),
    "twitter": re.compile(r"^/([A-Za-z0-9_]{1,30})/?$"),
    "facebook": re.compile(r"^/([A-Za-z0-9.\-]{3,60})/?$"),
}
_RESERVED = {"profile.php", "pages", "people", "groups", "watch", "share", "p", "reel", "reels", "tv", "stories", "i", "home"}


def _clean(text: object, limit: int) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:limit]


def _https_host(url: object) -> tuple[str, str] | None:
    try:
        p = urlparse(str(url or "").strip())
    except ValueError:
        return None
    if p.scheme != "https" or not p.hostname or p.username or p.password:
        return None
    return p.hostname.lower(), p.path


def _host_allowed(platform: str, host: str) -> bool:
    allowed = PROFILE_HOSTS.get(platform)
    if not allowed:
        return True  # other platforms: any https link the site itself returned
    return any(host == d or host.endswith("." + d) for d in allowed)


def handle_from_url(platform: str, url: object) -> str | None:
    parsed = _https_host(url)
    rx = _URL_HANDLE.get(platform)
    if not parsed or not rx or not _host_allowed(platform, parsed[0]):
        return None
    m = rx.search(parsed[1])
    h = m.group(1) if m else None
    return h if h and h.lower() not in _RESERVED and _HANDLE.match(h) else None


def _int(value: object) -> int | None:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if 0 <= n < 10**11 else None


def make(platform: str, *, name: object = None, handle: object = None, url: object = None, avatar: object = None,
         verified: object = False, followers: object = None, kind: str = "followers") -> dict | None:
    """Normalise raw values into one account record (None when there is nothing useful to show)."""
    h = _clean(handle, 61).lstrip("@")
    h = h if _HANDLE.match(h) else ""
    nm = _clean(name, 80)
    if not (nm or h):
        return None
    link = None
    parsed = _https_host(url)
    if parsed and _host_allowed(platform, parsed[0]):
        link = str(url).strip()
    elif h and platform in PROFILE_URL:
        link = PROFILE_URL[platform].format(h=quote(h, safe="@._-"))
    img = str(avatar).strip() if avatar and _https_host(avatar) else None
    return {"platform": platform, "name": nm or h, "handle": h or None, "url": link, "avatar": img,
            "verified": bool(verified), "followers": _int(followers), "kind": "subscribers" if kind == "subscribers" else "followers"}


def public(acc: dict | None) -> dict | None:
    """Response form: the avatar goes through the signed same-origin image proxy (no hotlink / CSP problems)."""
    if not acc:
        return None
    out = dict(acc)
    out["avatar"] = proxied_image(acc.get("avatar"), width=240) if acc.get("avatar") else None
    return out


def from_ytdlp(info: dict, platform: str) -> dict | None:
    """Account of a post extracted with yt-dlp (YouTube, TikTok video, Instagram, Facebook, X ...)."""
    ig = info.get("_mg_ig") if platform == "instagram" else None
    if ig and (ig.get("username") or ig.get("full_name")):
        return make("instagram", name=ig.get("full_name") or ig.get("username"), handle=ig.get("username"),
                    avatar=ig.get("avatar"), verified=ig.get("verified"))

    url = info.get("uploader_url") or info.get("channel_url")
    uid = _clean(info.get("uploader_id"), 80)
    handle = handle_from_url(platform, url)
    if not handle and platform == "youtube" and uid.startswith("@"):
        handle = uid[1:]
    if not handle and uid and not uid.isdigit() and platform in ("instagram", "twitter", "tiktok") and _HANDLE.match(uid):
        handle = uid
    if not handle and platform == "tiktok" and _HANDLE.match(_clean(info.get("uploader"), 61)):
        handle = _clean(info.get("uploader"), 61)  # yt-dlp's TikTok "uploader" is the @unique id

    names = [info.get("channel"), info.get("creator"), info.get("uploader"), info.get("display_name")]
    name = next((_clean(n, 80) for n in names if _clean(n, 80)), "")
    if platform == "facebook" and uid.isdigit() and not url:
        url = f"https://www.facebook.com/{uid}"
    followers = info.get("channel_follower_count") if info.get("channel_follower_count") is not None else info.get("uploader_follower_count")
    return make(platform, name=name or None, handle=handle, url=url,
                verified=info.get("channel_is_verified") or info.get("uploader_verified"),
                followers=followers, kind="subscribers" if platform == "youtube" else "followers")
