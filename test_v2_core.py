"""Utilities, error handling and the YouTube retry plan (no network)."""
import io

import pytest
from PIL import Image

from app import ytdl
from app.media import build_gallery
from app.utils import image_dimensions, is_public_http_url, proxied_image, sniff_media


@pytest.mark.parametrize("fmt,ext", [("PNG", "png"), ("JPEG", "jpg"), ("WEBP", "webp"), ("GIF", "gif")])
def test_sniff_and_dimensions(tmp_path, fmt, ext):
    p = tmp_path / f"x.{ext}"
    Image.new("RGB", (321, 123), (10, 20, 30)).save(p, fmt)
    head = p.read_bytes()[:64]
    assert sniff_media(head) == ("image", ext)
    assert image_dimensions(p) == (321, 123)


def test_sniff_rejects_html_and_detects_media():
    assert sniff_media(b"<!doctype html><html>") is None
    assert sniff_media(b"\x00\x00\x00\x20ftypisom") == ("video", "mp4")
    assert sniff_media(b"ID3\x04\x00") == ("audio", "mp3")


def test_public_url_guard():
    assert not is_public_http_url("http://127.0.0.1/x")
    assert not is_public_http_url("http://169.254.169.254/latest/meta-data")
    assert not is_public_http_url("http://10.0.0.5/a.jpg")
    assert not is_public_http_url("file:///etc/passwd")
    assert not is_public_http_url("http://localhost/")


def test_new_error_messages():
    code, msg = ytdl.humanize_error("ERROR: [youtube] abc: Failed to extract any player response; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template.")
    assert code == "yt_blocked" and "github" not in msg.lower()
    assert ytdl.humanize_error("ERROR: Postprocessing: Conversion failed!")[0] == "ffmpeg_failed"
    assert ytdl.humanize_error("ERROR: There is no video in this post")[0] == "no_video"
    assert ytdl.humanize_error("You must be logged in to continue viewing images")[0] == "login_required"
    code, msg = ytdl.humanize_error("Something odd happened; please report this issue on https://github.com/yt-dlp/yt-dlp/issues")
    assert code == "failed" and "report this issue" not in msg


def test_youtube_attempts_retry_without_stale_cookies(monkeypatch):
    monkeypatch.setattr(ytdl, "has_cookies", lambda p: True)
    plan = ytdl.youtube_attempts("youtube")
    assert plan[0].cookies is True and any(not a.cookies for a in plan)
    assert plan.index(next(a for a in plan if not a.cookies)) >= 1  # cookie-less attempts come after
    first = [a for a in ytdl.youtube_attempts("youtube", first_cookies=False)]
    assert first[0].cookies is False  # cached info came from a cookie-less attempt
    monkeypatch.setattr(ytdl, "has_cookies", lambda p: False)
    assert all(not a.cookies for a in ytdl.youtube_attempts("youtube"))
    assert ytdl.youtube_attempts("tiktok") == [ytdl.Attempt(None, False)]
    assert ytdl.is_youtube_retryable("Failed to extract any player response")
    assert ytdl.is_youtube_retryable("HTTP Error 429: Too Many Requests")
    assert not ytdl.is_youtube_retryable("This video has been removed by the uploader")


def test_max_height_and_hidden_formats():
    info = {"formats": [{"vcodec": "vp9", "width": 3840, "height": 2160}, {"vcodec": "none", "acodec": "opus"}, {"vcodec": "avc1", "width": 1080, "height": 1920}]}
    assert ytdl.max_video_height(info) == 2160
    lg = ytdl.CollectLogger()
    lg.warning("[youtube] x: Some web_embedded client https formats have been skipped as they are missing a URL. YouTube may have enabled the SABR-only streaming experiment")
    assert ytdl.formats_hidden(lg)


def test_gallery_response_uses_signed_previews():
    g = {"platform": "instagram", "media_type": "carousel", "id": "A", "title": "T", "items": [
        {"index": 1, "type": "image", "url": "https://scontent.cdninstagram.com/a.jpg", "preview": "https://scontent.cdninstagram.com/a.jpg", "width": 1080, "height": 1350, "ext": "jpg"},
        {"index": 2, "type": "audio", "url": "https://x/s.mp3", "preview": None, "ext": "mp3"}]}
    d = build_gallery(g, "https://www.instagram.com/p/A/")
    assert d["type"] == "gallery" and d["counts"] == {"image": 1, "video": 0, "audio": 1}
    assert d["items"][0]["preview"].startswith("/api/thumb?") and "w=480" in d["items"][0]["preview"]
    assert d["items"][0]["label"] == "1080×1350" and "url" not in d["items"][0]  # raw CDN URLs never leave the server
    assert proxied_image("https://a/b.jpg", width=480) != proxied_image("https://a/b.jpg")
