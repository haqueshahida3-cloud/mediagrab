"""Background download jobs: queue, progress tracking, cancellation and cleanup."""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import yt_dlp
from yt_dlp.postprocessor.common import PostProcessor
from yt_dlp.utils import DownloadCancelled, DownloadError

from .config import settings
from .media import AUDIO_PRESETS, nice_title
from .utils import clean_title, proxied_image
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

ACTIVE = {"queued", "preparing", "downloading", "processing"}
DONE = {"finished", "error", "cancelled"}

PP_STAGES = [
    ("Merger", "merging"),
    ("ExtractAudio", "converting"),
    ("EmbedThumbnail", "embedding_thumbnail"),
    ("ThumbnailsConvertor", "thumbnail"),
    ("Metadata", "metadata"),
    ("EmbedSubtitle", "embedding_subs"),
    ("SubtitlesConvertor", "subtitles"),
    ("SponsorBlock", "sponsorblock"),
    ("ModifyChapters", "sponsorblock"),
    ("VideoConvertor", "converting"),
    ("VideoRemuxer", "converting"),
    ("Fixup", "finalizing"),
    ("MoveFiles", "finalizing"),
]

_SKIP_SUFFIXES = {".part", ".ytdl", ".jpg", ".jpeg", ".webp", ".png", ".vtt", ".srt", ".json", ".temp", ".txt"}


def _tool(name: str) -> str:
    """Path of ffmpeg/ffprobe honouring FFMPEG_LOCATION (dir or binary path)."""
    loc = settings.ffmpeg_location
    if loc:
        p = Path(loc)
        if p.is_dir():
            return str(p / name)
        return str(p.with_name(p.name.replace("ffmpeg", name))) if "ffmpeg" in p.name else str(p)
    return shutil.which(name) or name


class _Skipped(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _PlanPP(PostProcessor):
    """Runs right before the download starts: records which formats (parts) will be fetched."""

    def __init__(self, job: "Job", plan: dict):
        super().__init__(None)
        self.job = job
        self.plan = plan

    def run(self, info):
        req = info.get("requested_formats") or [info]
        self.plan["parts"] = [
            {"size": int(f.get("filesize") or f.get("filesize_approx") or 0), "video": f.get("vcodec") != "none"}
            for f in req
        ]
        if (info.get("title") or info.get("description")) and (not self.job.title or self.job.title.startswith("http")):
            self.job.title = nice_title(info)[:200]
        if not self.job.thumbnail and info.get("thumbnail"):
            self.job.thumbnail = proxied_image(info["thumbnail"])
        return [], info


@dataclass
class Job:
    id: str
    url: str
    platform: str
    kind: str  # video | audio
    quality: str
    options: dict
    client_ip: str
    playlist_index: int | None = None
    title: str = ""
    thumbnail: str | None = None
    label: str = ""
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    speed: float | None = None
    eta: int | None = None
    downloaded: int = 0
    total: int = 0
    filesize: int = 0
    filename: str = ""
    filepath: str = ""
    error: str = ""
    error_code: str = ""
    created: float = field(default_factory=time.time)
    started: float = 0.0
    finished: float = 0.0
    cancel_requested: bool = False
    served: int = 0

    def public(self, queue_position: int | None = None) -> dict:
        ttl = settings.file_ttl_minutes * 60
        return {
            "id": self.id,
            "url": self.url,
            "platform": self.platform,
            "kind": self.kind,
            "quality": self.quality,
            "label": self.label,
            "title": self.title,
            "thumbnail": self.thumbnail,
            "status": self.status,
            "stage": self.stage,
            "progress": round(self.progress, 1),
            "speed": self.speed,
            "eta": self.eta,
            "downloaded": self.downloaded,
            "total": self.total,
            "filesize": self.filesize,
            "filename": self.filename,
            "error": self.error,
            "error_code": self.error_code,
            "created": self.created,
            "finished": self.finished or None,
            "queue_position": queue_position,
            "expires": (self.finished + ttl) if (self.finished and self.status == "finished") else None,
            "file_url": f"/api/jobs/{self.id}/file" if self.status == "finished" else None,
        }


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=max(1, settings.max_concurrent_downloads), thread_name_prefix="dl")
        self.stats = {"completed": 0, "failed": 0, "bytes": 0, "started_at": time.time()}

    # ------------------------------------------------------------------ public API
    def create(self, **kwargs) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], **kwargs)
        with self.lock:
            self.jobs[job.id] = job
        self.executor.submit(self._run, job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def public(self, job: Job) -> dict:
        return job.public(self.queue_position(job))

    def queue_position(self, job: Job) -> int | None:
        if job.status != "queued":
            return None
        with self.lock:
            return 1 + sum(1 for j in self.jobs.values() if j.status == "queued" and j.created < job.created)

    def active_count(self, ip: str | None = None) -> int:
        with self.lock:
            return sum(1 for j in self.jobs.values() if j.status in ACTIVE and (ip is None or j.client_ip == ip))

    def counts(self) -> dict:
        with self.lock:
            out: dict[str, int] = {}
            for j in self.jobs.values():
                out[j.status] = out.get(j.status, 0) + 1
            return out

    def cancel(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if not job:
            return None
        if job.status in ACTIVE:
            job.cancel_requested = True
            if job.status == "queued":
                self._mark_cancelled(job)
        return job

    def remove(self, job_id: str) -> bool:
        job = self.cancel(job_id)
        if not job:
            return False
        if job.status in DONE:
            with self.lock:
                self.jobs.pop(job_id, None)
            shutil.rmtree(settings.download_dir / job_id, ignore_errors=True)
        return True

    def cleanup(self) -> None:
        now = time.time()
        ttl = settings.file_ttl_minutes * 60
        with self.lock:
            stale = [
                j for j in self.jobs.values()
                if (j.status in DONE and j.finished and now - j.finished > ttl) or (now - j.created > max(ttl * 6, 7200))
            ]
            for j in stale:
                self.jobs.pop(j.id, None)
        for j in stale:
            j.cancel_requested = True
            shutil.rmtree(settings.download_dir / j.id, ignore_errors=True)
        known = set(self.jobs)
        for d in settings.download_dir.iterdir():
            try:
                if d.is_dir() and d.name not in known and now - d.stat().st_mtime > 600:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
        for d in settings.tmp_dir.iterdir():
            try:
                if now - d.stat().st_mtime > 3600:
                    shutil.rmtree(d, ignore_errors=True) if d.is_dir() else d.unlink(missing_ok=True)
            except OSError:
                pass

    def shutdown(self) -> None:
        for j in list(self.jobs.values()):
            j.cancel_requested = True
        self.executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ worker
    def _mark_cancelled(self, job: Job) -> None:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.speed = job.eta = None
        job.finished = time.time()

    def _run(self, job: Job) -> None:
        if job.cancel_requested or job.status == "cancelled":
            return
        job.status, job.stage, job.started = "preparing", "preparing", time.time()
        job_dir = settings.download_dir / job.id
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            path = self._download(job, job_dir)
            if job.cancel_requested:
                raise DownloadCancelled("Cancelled by user")
            path = self._ensure_mp3_bitrate(job, path)
            job.filepath = str(path)
            job.filesize = path.stat().st_size
            job.filename = self._display_name(job, path)
            job.progress = 100.0
            job.speed = job.eta = None
            job.status = job.stage = "finished"
            job.finished = time.time()
            self.stats["completed"] += 1
            self.stats["bytes"] += job.filesize
        except DownloadCancelled:
            self._mark_cancelled(job)
            shutil.rmtree(job_dir, ignore_errors=True)
        except (MediaError, _Skipped) as e:
            self._fail(job, getattr(e, "code", "failed"), e.message)
            shutil.rmtree(job_dir, ignore_errors=True)
        except Exception as e:  # noqa: BLE001
            code, msg = humanize_error(str(e))
            self._fail(job, code, msg)
            shutil.rmtree(job_dir, ignore_errors=True)

    def _ensure_mp3_bitrate(self, job: Job, path: Path) -> Path:
        """yt-dlp stream-copies when the source is already MP3 (e.g. TikTok sounds), ignoring the requested
        bitrate. Re-encode so the file matches what the user picked (cover art + tags are preserved)."""
        preset = AUDIO_PRESETS.get(job.quality) or {}
        if job.kind != "audio" or preset.get("codec") != "mp3" or not preset.get("kbps") or path.suffix.lower() != ".mp3":
            return path
        try:
            probe = subprocess.run(
                [_tool("ffprobe"), "-v", "error", "-show_entries", "stream=codec_type,bit_rate", "-of", "json", str(path)],
                capture_output=True, text=True, timeout=60,
            )
            streams = json.loads(probe.stdout or "{}").get("streams", [])
            audio = next((st for st in streams if st.get("codec_type") == "audio"), {})
            current = int(float(audio.get("bit_rate") or 0)) // 1000
            has_cover = any(st.get("codec_type") == "video" for st in streams)
        except (OSError, ValueError, subprocess.SubprocessError):
            return path
        if not current or abs(current - preset["kbps"]) <= 16:
            return path
        job.status, job.stage = "processing", "converting"
        tmp = path.with_name("media.reencode.mp3")
        cmd = [_tool("ffmpeg"), "-y", "-v", "error", "-i", str(path), "-map", "0:a:0"]
        if has_cover:
            cmd += ["-map", "0:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"]
        cmd += ["-c:a", "libmp3lame", "-b:a", f"{preset['kbps']}k", "-map_metadata", "0", "-id3v2_version", "3", str(tmp)]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                tmp.replace(path)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            tmp.unlink(missing_ok=True)
        return path

    def _fail(self, job: Job, code: str, message: str) -> None:
        job.status = job.stage = "error"
        job.error_code = code
        job.error = message
        job.speed = job.eta = None
        job.finished = time.time()
        self.stats["failed"] += 1

    def _download(self, job: Job, job_dir: Path) -> Path:
        cached = None if job.playlist_index else info_cache.get(job.url)
        first_clients = (cached or {}).get("_mg_clients")
        plan: list[tuple[str, list[str] | None]] = []
        if cached:
            plan.append(("cache", first_clients))
        plan += [("fresh", c) for c in youtube_attempts(job.platform, first_clients)]

        last_error = ""
        for mode, clients in plan:
            try:
                return self._attempt(job, job_dir, mode, clients, cached)
            except DownloadCancelled:
                raise
            except _Skipped:
                raise
            except DownloadError as e:
                last_error = str(e)
                if job.cancel_requested:
                    raise DownloadCancelled("Cancelled by user") from None
                self._reset(job, job_dir)
                code, _ = humanize_error(last_error)
                if code in ("too_large", "cancelled", "private", "unavailable", "unsupported"):
                    break
                if mode == "cache":
                    continue  # cached stream URLs may have expired → fresh extraction
                if is_bot_check(last_error):
                    continue  # try next YouTube player client
                break
        code, msg = humanize_error(last_error or "Download failed")
        raise MediaError(msg, code)

    def _attempt(self, job: Job, job_dir: Path, mode: str, clients: list[str] | None, cached: dict | None) -> Path:
        logger = CollectLogger()
        final_files: list[str] = []
        skip: dict[str, str] = {}
        with private_cookies(job.platform, job_dir) as cookiefile:
            opts = self._build_opts(job, logger, clients, skip)
            opts["paths"] = {"home": str(job_dir), "temp": str(job_dir)}
            if cookiefile:
                opts["cookiefile"] = cookiefile
            plan: dict = {"parts": []}
            opts["progress_hooks"] = [self._progress_hook(job, plan)]
            opts["postprocessor_hooks"] = [self._pp_hook(job)]
            opts["post_hooks"] = [final_files.append]
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.add_post_processor(_PlanPP(job, plan), when="before_dl")
                if mode == "cache" and cached is not None:
                    ydl.process_ie_result(cached, download=True)
                else:
                    ydl.download([job.url])
        if job.cancel_requested:
            raise DownloadCancelled("Cancelled by user")
        if skip:
            raise _Skipped(skip["code"], skip["message"])
        path = self._resolve_output(final_files, job_dir)
        if path:
            return path
        joined = " ".join(logger.errors + logger.warnings)
        raise DownloadError(joined or "Download finished but no file was produced")

    def _reset(self, job: Job, job_dir: Path) -> None:
        job.progress = 0.0
        job.downloaded = job.total = 0
        job.speed = job.eta = None
        job.status, job.stage = "preparing", "retrying"
        for p in job_dir.iterdir():
            if p.name != ".cookies.txt":
                shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)

    @staticmethod
    def _resolve_output(final_files: list[str], job_dir: Path) -> Path | None:
        for fp in reversed(final_files):
            p = Path(fp)
            if p.is_file() and p.stat().st_size > 0:
                return p
        candidates = [
            p for p in job_dir.iterdir()
            if p.is_file() and not p.name.startswith(".") and p.suffix.lower() not in _SKIP_SUFFIXES and p.stat().st_size > 0
        ]
        return max(candidates, key=lambda p: p.stat().st_size, default=None)

    def _build_opts(self, job: Job, logger: CollectLogger, clients: list[str] | None, skip: dict) -> dict:
        o = job.options or {}
        args = ["--ignore-config"]
        if job.kind == "audio":
            preset = AUDIO_PRESETS[job.quality]
            codec = preset["codec"]
            fmt = {"m4a": "ba[ext=m4a]/ba[acodec^=mp4a]/ba/b", "opus": "ba[acodec=opus]/ba/b"}.get(codec, "ba/b")
            args += ["-f", fmt, "-x", "--audio-format", codec]
            if codec in ("mp3", "m4a", "opus"):
                args += ["-S", "channels:2"]  # stereo source: smaller download, no lossy 5.1 downmix surprises
            if preset["kbps"]:
                args += ["--audio-quality", f"{preset['kbps']}K"]
            if o.get("embed_metadata", True) and codec in ("mp3", "m4a", "opus", "flac"):
                args += ["--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"]
        else:
            sort = []
            if job.quality and job.quality.isdigit():
                sort.append(f"res:{int(job.quality)}")
            if o.get("prefer_h264", True):
                # "max compatibility": H.264 video + stereo AAC plays on every phone, TV and editor
                sort += ["vcodec:h264", "channels:2"]
            sort.append("ext:mp4:m4a")
            args += ["-f", "bv*+ba/b", "-S", ",".join(sort), "--merge-output-format", "mp4"]
            if o.get("embed_metadata"):
                args += ["--embed-metadata", "--embed-chapters"]
            if o.get("embed_subs") and o.get("sub_lang"):
                args += ["--embed-subs", "--write-subs", "--write-auto-subs", "--sub-langs", o["sub_lang"]]
            if o.get("sponsorblock") and job.platform == "youtube":
                args += ["--sponsorblock-remove", "sponsor,selfpromo,interaction"]

        start, end = o.get("trim_start_s"), o.get("trim_end_s")
        trimmed = start is not None or end is not None
        if trimmed:
            args += ["--download-sections", f"*{start or 0}-{end if end is not None else 'inf'}"]
            # Audio clips are always cut accurately: stream-copying WebM/Opus starts at the previous
            # seek point (up to ~10 s early) and audio re-encoding is cheap anyway.
            if o.get("precise_cut") or job.kind == "audio":
                args += ["--force-keyframes-at-cuts"]
        if job.playlist_index:
            args += ["--yes-playlist", "--playlist-items", str(job.playlist_index)]

        opts = yt_dlp.parse_options(args).ydl_opts
        opts.update(base_opts(job.platform, logger, clients))
        opts.update({
            "outtmpl": {"default": "media.%(ext)s"},
            "noplaylist": not job.playlist_index,
            "extract_flat": False,
            "ignoreerrors": False,
            "skip_download": False,
        })
        if settings.max_filesize_mb:
            opts["max_filesize"] = settings.max_filesize_mb * 1024 * 1024

        limit = settings.max_duration_minutes * 60

        def match_filter(info: dict, *, incomplete: bool = False):
            if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
                skip.update(code="live", message="Live streams and upcoming premieres can't be downloaded until they end.")
                return "live"
            dur = info.get("duration")
            if limit and dur and dur > limit and not trimmed:
                skip.update(code="too_long", message=(
                    f"Videos longer than {settings.max_duration_minutes} minutes aren't allowed on this server. "
                    "Use Trim to download a part of it."))
                return "too long"
            return None

        opts["match_filter"] = match_filter
        return opts

    def _progress_hook(self, job: Job, plan: dict):
        parts: dict[str, list[int]] = {}
        order: list[str] = []

        def hook(d: dict) -> None:
            if job.cancel_requested:
                raise DownloadCancelled("Cancelled by user")
            info = d.get("info_dict") or {}
            fn = d.get("filename") or d.get("tmpfilename") or "file"
            if fn not in parts:
                parts[fn] = [0, 0]
                order.append(fn)
            done = int(d.get("downloaded_bytes") or 0)
            total = int(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
            if d.get("status") == "finished":
                total = total or done
                done = total
            elif not total and d.get("fragment_count"):
                # HLS/DASH without size info: use fragment ratio as a pseudo byte count
                total, done = int(d["fragment_count"]), int(d.get("fragment_index") or 0)
            parts[fn] = [done, total]

            planned = plan.get("parts") or []
            n = max(1, len(planned), len(order))
            weights, fracs = [], []
            for i in range(n):
                p_done, p_total = parts[order[i]] if i < len(order) else (0, 0)
                planned_size = planned[i]["size"] if i < len(planned) else 0
                weights.append(planned_size or p_total or 1)
                fracs.append(min(1.0, p_done / p_total) if p_total else 0.0)
            sizes_known = bool(planned) and all(p["size"] for p in planned)
            if not sizes_known:
                weights = [1] * n  # unknown sizes → equal weights
            overall = sum(f * w for f, w in zip(fracs, weights)) / sum(weights)
            job.progress = max(job.progress, min(99.0, round(overall * 100, 1)))
            job.downloaded = sum(p[0] for p in parts.values())
            known_total = sum(p["size"] for p in planned) if planned and all(p["size"] for p in planned) else 0
            job.total = known_total or sum(p[1] for p in parts.values())
            if d.get("status") == "downloading":
                job.status = "downloading"
                job.speed = d.get("speed")
                job.eta = d.get("eta")
                if n > 1:
                    job.stage = "downloading_audio" if info.get("vcodec") == "none" else "downloading_video"
                else:
                    job.stage = "downloading"

        return hook

    def _pp_hook(self, job: Job):
        def hook(d: dict) -> None:
            if d.get("status") != "started":
                return
            name = d.get("postprocessor") or ""
            stage = next((s for key, s in PP_STAGES if key in name), None)
            if not stage:
                return
            job.status = "processing"
            job.stage = stage
            job.speed = job.eta = None
            job.progress = max(job.progress, 99.0)

        return hook

    @staticmethod
    def _display_name(job: Job, path: Path) -> str:
        o = job.options or {}
        custom = (o.get("filename") or "").strip()
        base = clean_title(custom or job.title or "media", 120)
        ext = path.suffix.lstrip(".") or ("mp3" if job.kind == "audio" else "mp4")
        if custom:
            return f"{base}.{ext}"
        tag = job.label or ""
        if o.get("trim_start_s") is not None or o.get("trim_end_s") is not None:
            tag = f"{tag} clip".strip()
        return f"{base} ({tag}).{ext}" if tag else f"{base}.{ext}"


manager = JobManager()
