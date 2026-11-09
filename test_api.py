from fastapi.testclient import TestClient

from app.main import app


def test_health_config_and_validation():
    with TestClient(app) as c:
        h = c.get("/api/health").json()
        assert h["status"] == "ok" and "yt_dlp" in h
        cfg = c.get("/api/config").json()
        assert "youtube" in cfg["platforms"] and any(p["id"] == "mp3-320" for p in cfg["audio_presets"])

        r = c.post("/api/info", json={"url": "definitely not a link"})
        assert r.status_code == 400 and r.json()["code"] == "invalid_url"
        r = c.post("/api/info", json={"url": "http://127.0.0.1/admin"})
        assert r.status_code == 400

        r = c.post("/api/download", json={"url": "https://youtu.be/x", "kind": "video", "quality": "9999999"})
        assert r.status_code == 400
        r = c.post("/api/download", json={"url": "https://youtu.be/x", "kind": "audio", "quality": "mp9"})
        assert r.status_code == 400
        r = c.post("/api/download", json={"url": "https://youtu.be/x", "kind": "gif"})
        assert r.status_code == 422

        assert c.get("/api/jobs?ids=nothex,../../etc").json() == {"jobs": [], "missing": []}
        assert c.get("/api/jobs/0123456789abcdef").status_code == 404
        assert c.get("/api/thumb", params={"u": "https://example.com/a.jpg", "s": "bad"}).status_code == 403


def test_frontend_routes():
    with TestClient(app) as c:
        assert "MediaGrab" in c.get("/").text
        assert c.get("/sw.js").headers["service-worker-allowed"] == "/"
        assert c.get("/manifest.webmanifest").json()["share_target"]["action"] == "/"
        assert c.get("/static/js/app.js").status_code == 200
