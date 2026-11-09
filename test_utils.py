import pytest

from app.utils import (
    InvalidURL, clean_title, content_disposition, detect_platform, extract_url,
    parse_timestamp, proxied_image, sign, validate_public_url, verify,
)
from app.ytdl import humanize_error, is_bot_check


@pytest.mark.parametrize("text,expected", [
    ("https://youtu.be/abc123", "https://youtu.be/abc123"),
    ("Check this out! https://vt.tiktok.com/ZS123/ 😂", "https://vt.tiktok.com/ZS123/"),
    ("watch: https://x.com/user/status/1.", "https://x.com/user/status/1"),
    ("www.instagram.com/reel/abc/", "https://www.instagram.com/reel/abc/"),
    ("hello world", None),
    ("", None),
])
def test_extract_url(text, expected):
    assert extract_url(text) == expected


@pytest.mark.parametrize("url,platform", [
    ("https://www.youtube.com/watch?v=x", "youtube"),
    ("https://m.youtube.com/shorts/x", "youtube"),
    ("https://youtu.be/x", "youtube"),
    ("https://fb.watch/abc/", "facebook"),
    ("https://web.facebook.com/reel/1", "facebook"),
    ("https://www.instagram.com/reel/x/", "instagram"),
    ("https://x.com/a/status/1", "twitter"),
    ("https://twitter.com/a/status/1", "twitter"),
    ("https://vm.tiktok.com/x/", "tiktok"),
    ("https://notyoutube.com/watch", "other"),
    ("https://example.com/video.mp4", "other"),
])
def test_detect_platform(url, platform):
    assert detect_platform(url) == platform


@pytest.mark.parametrize("bad", [
    "http://127.0.0.1:8000/x", "http://localhost/a", "http://10.0.0.5/v", "http://169.254.169.254/latest/meta-data",
    "http://[::1]/", "ftp://example.com/a", "not a url", "http://printer.local/x",
])
def test_validate_public_url_blocks_internal_targets(bad):
    with pytest.raises(InvalidURL):
        validate_public_url(bad)


@pytest.mark.parametrize("value,seconds", [("90", 90), ("1:30", 90), ("01:02:03.5", 3723.5), ("0", 0), ("", None), (None, None)])
def test_parse_timestamp(value, seconds):
    assert parse_timestamp(value) == seconds


@pytest.mark.parametrize("bad", ["1:2:3:4", "abc", "-5", "1:3a"])
def test_parse_timestamp_rejects_garbage(bad):
    with pytest.raises(ValueError):
        parse_timestamp(bad)


def test_clean_title():
    assert clean_title('a/b\\c:d*e?f"g<h>i|j') == "a b c d e f g h i j"
    assert clean_title("   ...   ") == "media"
    assert len(clean_title("x" * 500, 100)) == 100
    assert clean_title("বাংলা গান 🎵") == "বাংলা গান 🎵"


def test_content_disposition_has_utf8_and_ascii_fallback():
    cd = content_disposition("বাংলা ভিডিও (720p).mp4")
    assert cd.startswith("attachment;")
    assert "filename*=UTF-8''" in cd
    assert 'filename="' in cd and cd.count(".mp4") >= 1
    assert content_disposition("a.mp4", inline=True).startswith("inline;")


def test_signing_roundtrip():
    s = sign("https://i.ytimg.com/vi/x/hq.jpg")
    assert verify("https://i.ytimg.com/vi/x/hq.jpg", s)
    assert not verify("https://evil.example/x.jpg", s)
    url = proxied_image("https://i.ytimg.com/vi/x/hq.jpg", "My video", download=True)
    assert url.startswith("/api/thumb?") and "dl=1" in url
    assert proxied_image("javascript:alert(1)") is None


@pytest.mark.parametrize("raw,code", [
    ("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies", "bot_check"),
    ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "private"),
    ("ERROR: Unsupported URL: https://example.com/", "unsupported"),
    ("ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required", "login_required"),
    ("ERROR: [youtube] abc: Video unavailable", "unavailable"),
    ("ERROR: [twitter] 1: No video could be found in this tweet", "no_video"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "forbidden"),
    ("something totally new", "failed"),
])
def test_humanize_error(raw, code):
    got, msg = humanize_error(raw)
    assert got == code and msg
    assert is_bot_check(raw) == (code == "bot_check")
