"""Application configuration.

Every value can be overridden with an environment variable (see `.env.example`).
"""
from __future__ import annotations

import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: str, sep: str = ",") -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(sep) if item.strip()]


class Settings:
    def __init__(self) -> None:
        self.app_name: str = os.getenv("APP_NAME", "MediaGrab")
        self.version: str = "1.0.0"

        # Paths
        self.static_dir: Path = BASE_DIR / "static"
        self.data_dir: Path = Path(os.getenv("DATA_DIR", "/tmp/mediagrab"))
        self.download_dir: Path = self.data_dir / "jobs"
        self.tmp_dir: Path = self.data_dir / "tmp"
        self.cache_dir: Path = self.data_dir / "cache"

        # Limits
        self.file_ttl_minutes: int = _env_int("FILE_TTL_MINUTES", 30)
        self.max_concurrent_downloads: int = _env_int("MAX_CONCURRENT_DOWNLOADS", 3)
        self.max_jobs_per_ip: int = _env_int("MAX_JOBS_PER_IP", 25)
        self.max_filesize_mb: int = _env_int("MAX_FILESIZE_MB", 2048)
        self.max_duration_minutes: int = _env_int("MAX_DURATION_MINUTES", 240)  # 0 = unlimited
        self.max_playlist_items: int = _env_int("MAX_PLAYLIST_ITEMS", 100)
        self.rate_limit_info: int = _env_int("RATE_LIMIT_INFO", 40)  # requests / minute / IP
        self.rate_limit_download: int = _env_int("RATE_LIMIT_DOWNLOAD", 30)
        self.info_cache_ttl: int = _env_int("INFO_CACHE_TTL", 900)  # seconds

        # Network / auth
        self.proxy: str = os.getenv("PROXY", "").strip()
        self.cookies_dir: str = os.getenv("COOKIES_DIR", str(BASE_DIR / "cookies")).strip()
        self.cookies_file: str = os.getenv("COOKIES_FILE", "").strip()
        self.ffmpeg_location: str = os.getenv("FFMPEG_LOCATION", "").strip()
        self.js_runtimes: list[str] = _env_list("JS_RUNTIMES", "deno,node")
        self.trust_proxy: bool = _env_bool("TRUST_PROXY", True)

        # YouTube: clients tried first, then fallbacks (";" separates attempts)
        self.youtube_clients: list[str] = _env_list("YOUTUBE_CLIENTS", "default,web_embedded")
        self.youtube_fallback_clients: list[list[str]] = [
            [c.strip() for c in group.split(",") if c.strip()]
            for group in os.getenv("YOUTUBE_FALLBACK_CLIENTS", "web_embedded,tv;mweb").split(";")
            if group.strip()
        ]

        for d in (self.data_dir, self.download_dir, self.tmp_dir, self.cache_dir):
            d.mkdir(parents=True, exist_ok=True)

        self.secret_key: str = self._load_secret()

    def _load_secret(self) -> str:
        env = os.getenv("SECRET_KEY", "").strip()
        if env:
            return env
        path = self.data_dir / ".secret"
        try:
            if path.exists():
                return path.read_text().strip()
            key = secrets.token_hex(32)
            path.write_text(key)
            return key
        except OSError:
            return secrets.token_hex(32)


settings = Settings()
