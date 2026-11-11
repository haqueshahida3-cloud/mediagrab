"""Pages, SEO files, security headers, admin auth, download manager and Media Tools API (no network)."""
import io
import json
import re
import shutil
import wave

import pytest
from fastapi.testclient import TestClient

from app import detect, pages
from app.config import settings
from app.main import app

PAGES = ["/", "/tools", "/about", "/platforms", "/how-to-use", "/faq", "/contact", "/privacy", "/terms", "/dmca", "/api-docs"]


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_all_pages_render_in_both_languages_with_seo(client):
    for path in PAGES:
        for lang in ("en", "bn"):
            r = client.get(path, params={"lang": lang})
            assert r.status_code == 200, path
            html = r.text
            assert f'<html lang="{lang}"' in html
            assert '<link rel="canonical"' in html and 'hreflang="bn"' in html and 'property="og:image"' in html
            for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
                json.loads(block)
    assert "FAQPage" in client.get("/faq").text
    r = client.get("/no-such-page")
    assert r.status_code == 404 and "text/html" in r.headers["content-type"]
    assert client.get("/api/no-such").json()["code"] == "http_404"


def test_sitemap_robots_manifest_sw(client):
    sm = client.get("/sitemap.xml").text
    for path in PAGES:
        assert f"{path}</loc>" in sm or path == "/"
    assert 'hreflang="bn"' in sm
    assert "Sitemap:" in client.get("/robots.txt").text and "Disallow: /api/" in client.get("/robots.txt").text
    m = client.get("/manifest.webmanifest").json()
    assert m["share_target"]["action"] == "/" and len(m["shortcuts"]) == 2
    sw = client.get("/sw.js")
    assert sw.headers["service-worker-allowed"] == "/" and settings.version in sw.text and "__VERSION__" not in sw.text


def test_security_headers_and_limits(client):
    html = client.get("/")
    csp = html.headers["content-security-policy"]
    assert "default-src 'self'" in csp and "script-src 'self'" in csp and "object-src 'none'" in csp
    assert "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
    assert html.headers["x-content-type-options"] == "nosniff"
    assert client.get("/api/health").headers["cache-control"] == "no-store"
    assert client.get("/static/js/core.js").headers["cache-control"] == "no-cache"
    assert "max-age" in client.get("/static/css/style.css?v=1").headers["cache-control"]
    big = client.post("/api/info", content=b"{" + b" " * 70_000 + b"}", headers={"content-type": "application/json"})
    assert big.status_code == 413
    assert "<script>" not in html.text.split("</head>")[0].replace('<script src=', '').replace('<script type="application/ld+json">', '')


def test_admin_disabled_and_enabled(client, monkeypatch):
    monkeypatch.setattr(settings, "admin_token", "")
    assert client.get("/admin").status_code == 404
    assert client.get("/api/admin/overview").status_code == 404
    monkeypatch.setattr(settings, "admin_token", "test-admin-token-123")
    assert client.get("/api/admin/session").json() == {"enabled": True, "authenticated": False}
    assert client.post("/api/admin/login", json={"token": "nope-nope-nope"}).status_code == 401
    r = client.post("/api/admin/login", json={"token": "test-admin-token-123"})
    assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower() and "samesite=strict" in r.headers["set-cookie"].lower()
    ov = client.get("/api/admin/overview").json()
    assert {"system", "jobs", "errors", "rate_limit", "versions", "cookies"} <= set(ov)
    assert client.post("/api/admin/errors/clear").status_code == 403  # CSRF header missing
    assert client.post("/api/admin/errors/clear", headers={"X-Requested-With": "MediaGrab"}).status_code == 200
    monkeypatch.setattr(settings, "admin_token", "rotated-admin-token-456")
    assert client.get("/api/admin/overview").status_code == 401  # rotating the token ends sessions


def test_download_manager_errors(client):
    for action in ("pause", "resume", "retry", "cancel"):
        assert client.post(f"/api/jobs/0123456789abcdef/{action}").status_code == 404
    assert client.post("/api/jobs/../../x/pause").status_code in (404, 405)


def test_detection_routing(monkeypatch):
    calls = []
    monkeypatch.setattr(detect.G, "tiktok_photo", lambda u: calls.append(("tt", u)) or {"platform": "tiktok", "items": [], "media_type": "photo"})
    monkeypatch.setattr(detect.G, "resolve_short_tiktok", lambda u: u)
    monkeypatch.setattr(detect.G, "twitter_media", lambda u: calls.append(("tw", u)) or None)
    monkeypatch.setattr(detect, "extract_info", lambda u, p=False: calls.append(("ytdlp", u)) or {"id": "1", "formats": [{"vcodec": "avc1"}]})
    r = detect.analyze("https://www.tiktok.com/@a/photo/7240568259186019630")
    assert "gallery" in r and calls[0][0] == "tt"
    calls.clear()
    r = detect.analyze("https://x.com/a/status/1790637656616943991")
    assert "raw" in r and [c[0] for c in calls] == ["tw", "ytdlp"]  # no photos → video flow


@pytest.mark.skipif(not shutil.which("ffprobe"), reason="ffmpeg not installed")
def test_media_tools_upload_probe_convert(client):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b"\x00\x10" * 16000)  # 1 second
    up = client.post("/api/tools/upload", content=buf.getvalue(), headers={"X-Filename": "tone.wav"}).json()
    assert up["kind"] == "audio" and len(up["upload_id"]) == 24
    p = client.post("/api/tools/probe", json={"upload_id": up["upload_id"]}).json()
    assert p["streams"][0]["type"] == "audio" and p["streams"][0]["sample_rate"] == 16000
    assert client.post("/api/tools/probe", json={"upload_id": "f" * 24}).status_code == 404
    assert client.post("/api/tools/convert", json={"upload_id": up["upload_id"], "target": "exe"}).status_code == 400
    assert client.delete(f"/api/tools/upload/{up['upload_id']}").json() == {"ok": True}
