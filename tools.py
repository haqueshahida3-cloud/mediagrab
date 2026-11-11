"""Media Tools (server side): uploads, detailed metadata (ffprobe) and audio conversion jobs.

Image conversion, EXIF viewing and video frame grabs run entirely in the browser (no upload needed).
"""
from __future__ import annotations

import json
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from typing import AsyncIterator, Callable

from .config import settings
from .utils import clean_title, sniff_media
from .ytdl import MediaError

MB = 1024 * 1024
UPLOAD_ID_RE = re.compile(r"^[a-f0-9]{24}$")

CONVERT_TARGETS: dict[str, dict] = {
    "mp3-320": {"ext": "mp3", "label": "MP3 320 kbps", "args": ["-c:a", "libmp3lame", "-b:a", "320k"]},
    "mp3-256": {"ext": "mp3", "label": "MP3 256 kbps", "args": ["-c:a", "libmp3lame", "-b:a", "256k"]},
    "mp3-192": {"ext": "mp3", "label": "MP3 192 kbps", "args": ["-c:a", "libmp3lame", "-b:a", "192k"]},
    "mp3-128": {"ext": "mp3", "label": "MP3 128 kbps", "args": ["-c:a", "libmp3lame", "-b:a", "128k"]},
    "m4a": {"ext": "m4a", "label": "M4A (AAC 256 kbps)", "args": ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"]},
    "wav": {"ext": "wav", "label": "WAV (PCM 16-bit)", "args": ["-c:a", "pcm_s16le"]},
    "flac": {"ext": "flac", "label": "FLAC (lossless)", "args": ["-c:a", "flac"]},
    "opus": {"ext": "opus", "label": "Opus 160 kbps", "args": ["-c:a", "libopus", "-b:a", "160k"]},
    "original": {"ext": None, "label": "Original audio (no re-encoding)", "args": ["-c:a", "copy"]},
}
_COPY_CONTAINER = {"aac": "m4a", "mp3": "mp3", "opus": "opus", "vorbis": "ogg", "flac": "flac", "alac": "m4a",
                   "pcm_s16le": "wav", "pcm_s24le": "wav", "ac3": "ac3", "eac3": "eac3"}


def _tool(name: str) -> str:
    from .jobs import tool
    return tool(name)


def _upload_dir(upload_id: str) -> Path:
    if not UPLOAD_ID_RE.match(upload_id or ""):
        raise MediaError("Invalid upload id.", "invalid_upload", 400)
    return settings.upload_dir / upload_id


def get_upload(upload_id: str) -> tuple[Path, dict]:
    d = _upload_dir(upload_id)
    meta_file = d / "meta.json"
    try:
        meta = json.loads(meta_file.read_text())
    except (OSError, ValueError):
        raise MediaError("This upload has expired. Please upload the file again.", "upload_expired", 404) from None
    path = d / meta["stored"]
    if not path.is_file():
        raise MediaError("This upload has expired. Please upload the file again.", "upload_expired", 404)
    return path, meta


async def save_upload(stream: AsyncIterator[bytes], filename: str, declared: int | None) -> dict:
    """Stream a raw request body to disk with a hard size limit. Returns upload metadata."""
    limit = settings.max_upload_mb * MB
    if declared and declared > limit:
        raise MediaError(f"This file is larger than the {settings.max_upload_mb} MB upload limit.", "too_large", 413)
    try:
        if shutil.disk_usage(settings.data_dir).free - (declared or 0) < settings.min_free_disk_mb * MB:
            raise MediaError("The server is low on disk space. Please try again later.", "disk_full", 507)
    except OSError:
        pass
    upload_id = secrets.token_hex(12)
    d = settings.upload_dir / upload_id
    d.mkdir(parents=True, exist_ok=True)
    name = clean_title(Path(filename or "file").name, 120)
    suffix = Path(name).suffix.lower()[:8] if re.fullmatch(r"\.[a-z0-9]{1,7}", Path(name).suffix.lower()) else ""
    stored = d / f"input{suffix}"
    size, head = 0, b""
    try:
        with open(stored, "wb") as fh:
            async for chunk in stream:
                if not chunk:
                    continue
                size += len(chunk)
                if size > limit:
                    raise MediaError(f"This file is larger than the {settings.max_upload_mb} MB upload limit.",
                                     "too_large", 413)
                if len(head) < 64:
                    head += chunk[: 64 - len(head)]
                fh.write(chunk)
        if size == 0:
            raise MediaError("The uploaded file is empty.", "empty", 400)
        sniffed = sniff_media(head)
        meta = {"id": upload_id, "name": name, "stored": stored.name, "size": size, "created": time.time(),
                "kind": sniffed[0] if sniffed else None}
        (d / "meta.json").write_text(json.dumps(meta))
        return meta
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise


def delete_upload(upload_id: str) -> None:
    shutil.rmtree(_upload_dir(upload_id), ignore_errors=True)


def probe_upload(upload_id: str) -> dict:
    path, meta = get_upload(upload_id)
    try:
        r = subprocess.run(
            [_tool("ffprobe"), "-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        data = json.loads(r.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        data = {}
    if not data.get("streams"):
        raise MediaError("This file couldn't be read as audio, video or an image.", "unreadable", 422)
    fmt = data.get("format") or {}
    streams = []
    for s in data["streams"]:
        kind = s.get("codec_type")
        if kind not in ("video", "audio", "subtitle"):
            continue
        is_cover = bool((s.get("disposition") or {}).get("attached_pic"))
        entry = {
            "type": "cover" if is_cover else kind,
            "codec": s.get("codec_name"),
            "codec_long": s.get("codec_long_name"),
            "profile": s.get("profile"),
            "bitrate": int(s.get("bit_rate") or 0) or None,
            "language": (s.get("tags") or {}).get("language"),
        }
        if kind == "video":
            from .jobs import _fps
            entry.update({
                "width": s.get("width"), "height": s.get("height"),
                "fps": _fps(s.get("avg_frame_rate")) or _fps(s.get("r_frame_rate")),
                "pix_fmt": s.get("pix_fmt"), "color_transfer": s.get("color_transfer"),
                "aspect": s.get("display_aspect_ratio"),
            })
        elif kind == "audio":
            entry.update({"sample_rate": int(s.get("sample_rate") or 0) or None, "channels": s.get("channels"),
                          "channel_layout": s.get("channel_layout"), "bits": s.get("bits_per_raw_sample")})
        streams.append(entry)
    tags = {k.lower(): str(v)[:300] for k, v in (fmt.get("tags") or {}).items()
            if k.lower() in ("title", "artist", "album", "album_artist", "date", "genre", "track", "comment",
                             "encoder", "creation_time", "composer", "copyright", "description", "major_brand")}
    return {
        "name": meta["name"],
        "size": meta["size"],
        "container": fmt.get("format_long_name") or fmt.get("format_name"),
        "format": fmt.get("format_name"),
        "duration": round(float(fmt.get("duration") or 0), 3) or None,
        "bitrate": int(fmt.get("bit_rate") or 0) or None,
        "streams": streams,
        "chapters": len(data.get("chapters") or []),
        "tags": tags,
    }


def run_convert(job, job_dir: Path, should_stop: Callable[[], bool]) -> Path:
    """Convert an uploaded file to an audio format with live progress (runs inside the job worker)."""
    upload_id = (job.options or {}).get("upload_id", "")
    target = (job.options or {}).get("target", "mp3-320")
    preset = CONVERT_TARGETS.get(target)
    if not preset:
        raise MediaError("Unknown output format.", "invalid_target")
    src, meta = get_upload(upload_id)
    info = probe_upload(upload_id)
    audio = next((s for s in info["streams"] if s["type"] == "audio"), None)
    if not audio:
        raise MediaError("This file has no audio track to extract.", "no_audio")
    ext = preset["ext"] or _COPY_CONTAINER.get(audio.get("codec") or "", "mka")
    duration = info.get("duration") or 0
    out = job_dir / f"converted.{ext}"
    cmd = [_tool("ffmpeg"), "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
           "-i", str(src), "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "0", *preset["args"]]
    if ext == "mp3":
        cmd += ["-id3v2_version", "3"]
    cmd.append(str(out))
    job.status, job.stage = "processing", "converting"
    job.total = meta["size"]
    started = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if should_stop():
                proc.kill()
                from yt_dlp.utils import DownloadCancelled
                raise DownloadCancelled("cancelled")
            key, _, val = line.strip().partition("=")
            if key in ("out_time_us", "out_time_ms") and duration:
                try:
                    secs = int(val) / 1_000_000
                except ValueError:
                    continue
                frac = max(0.0, min(0.99, secs / duration))
                job.progress = max(job.progress, round(frac * 100, 1))
                elapsed = time.time() - started
                job.eta = int(elapsed / frac - elapsed) if frac > 0.02 else None
                job.speed = None
        proc.wait(timeout=3600)
        err = (proc.stderr.read() if proc.stderr else "")[-500:]
    finally:
        if proc.poll() is None:
            proc.kill()
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise MediaError(f"Conversion failed: {err.strip().splitlines()[-1] if err.strip() else 'FFmpeg error'}",
                         "ffmpeg_failed")
    from .jobs import ffprobe, media_summary
    summary = media_summary(ffprobe(out))
    if not summary.get("acodec"):
        raise MediaError("Conversion produced a file without audio.", "ffmpeg_failed")
    job.media = summary
    stem = clean_title(Path(meta["name"]).stem or "audio", 110)
    tag = "original" if target == "original" else target.replace("mp3-", "") + ("kbps" if target.startswith("mp3") else "")
    job.filename = f"{stem} ({tag}).{ext}"
    return out
