"""Extra tools: subtitle download (SRT/VTT) using yt-dlp."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import yt_dlp
from yt_dlp.utils import DownloadError

from .config import settings
from .utils import clean_title, detect_platform
from .ytdl import (
    CollectLogger,
    MediaError,
    base_opts,
    humanize_error,
    info_cache,
    is_bot_check,
    private_cookies,
    youtube_attempts,
)

SUB_SUFFIXES = {".srt", ".vtt", ".ass", ".ttml", ".srv3", ".json3", ".lrc"}


def download_subtitle(url: str, lang: str, auto: bool, fmt: str) -> tuple[Path, str, Path]:
    """Returns (file_path, download_name, temp_dir_to_cleanup)."""
    platform = detect_platform(url)
    tmp = Path(tempfile.mkdtemp(prefix="sub-", dir=settings.tmp_dir))
    cached = info_cache.get(url)
    title = (cached or {}).get("title") or "subtitles"

    args = ["--ignore-config", "--skip-download", "--no-playlist", "--sub-langs", lang, "--sub-format", "vtt/srt/best"]
    args += ["--write-auto-subs"] if auto else ["--write-subs"]
    if fmt == "srt":
        args += ["--convert-subs", "srt"]

    plan: list[tuple[str, list[str] | None]] = []
    if cached:
        plan.append(("cache", cached.get("_mg_clients")))
    plan += [("fresh", c) for c in youtube_attempts(platform, (cached or {}).get("_mg_clients"))]

    last_error = ""
    try:
        for mode, clients in plan:
            logger = CollectLogger()
            with private_cookies(platform, tmp) as cookiefile:
                opts = yt_dlp.parse_options(args).ydl_opts
                opts.update(base_opts(platform, logger, clients))
                opts.update({
                    "outtmpl": {"default": "subs.%(ext)s"},
                    "paths": {"home": str(tmp), "temp": str(tmp)},
                    "skip_download": True,
                    "ignoreerrors": False,
                    "extract_flat": False,
                })
                if cookiefile:
                    opts["cookiefile"] = cookiefile
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        if mode == "cache" and cached is not None:
                            ydl.process_ie_result(cached, download=True)
                        else:
                            ydl.download([url])
                except DownloadError as e:
                    last_error = str(e)
                    if mode == "cache" or is_bot_check(last_error):
                        continue
                    break
            files = [p for p in tmp.iterdir() if p.suffix.lower() in SUB_SUFFIXES and p.stat().st_size > 0]
            if files:
                f = max(files, key=lambda p: p.stat().st_size)
                return f, f"{clean_title(title, 100)} [{lang}]{f.suffix}", tmp
            if mode == "cache":
                continue
            last_error = last_error or "No subtitles were found for this language."
            break
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    shutil.rmtree(tmp, ignore_errors=True)
    code, msg = humanize_error(last_error)
    raise MediaError(msg, code)
