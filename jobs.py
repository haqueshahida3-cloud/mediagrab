"""Background jobs: queue, progress, pause/resume, retry, cancellation, verification and cleanup.

Job kinds:  video | audio  (yt-dlp + FFmpeg)   gallery (photos / carousel items, ZIP)   convert (Media Tools)
"""
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
from .media import AUDIO_PRESETS, codec_name, display_res, nice_title
from .monitor import monitor
from .utils import clean_title, image_dimensions, proxied_image
from .ytdl import (
    TRANSIENT_CODES,
    Attempt,
    CollectLogger,
    MediaError,
    base_opts,
    has_cookies,
    humanize_error,
    info_cache,
    is_youtube_retryable,
    private_cookies,
    youtube_attempts,
)

MB = 1024 * 1024
ACTIVE = {"queued", "preparing", "downloading", "processing"}
DONE = {"finished", "error", "cancelled"}
PAUSABLE_KINDS = {"video", "audio", "gallery"}

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


def tool(name: str) -> str:
    """Path of ffmpeg/ffprobe honouring FFMPEG_LOCATION (dir or binary path)."""
    loc = settings.ffmpeg_location
    if loc:
        p = Path(loc)
        if p.is_dir():
            return str(p / name)
        return str(p.with_name(p.name.replace("ffmpeg", name))) if "ffmpeg" in p.name else str(p)
    return shutil.which(name) or name


def ffprobe(path: Path) -> dict:
    try:
        r = subprocess.run(
            [tool("ffprobe"), "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=90,
        )
        return json.loads(r.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def _fps(rate: str | None) -> float | None:
    try:
        num, den = (rate or "0/1").split("/")
        val = float(num) / float(den or 1)
        return round(val, 2) if val > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def media_summary(probe: dict) -> dict:
    """Compact description of an output file (shown in the download manager)."""
    streams = probe.get("streams") or []
    fmt = probe.get("format") or {}
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out: dict = {
        "container": (fmt.get("format_name") or "").split(",")[0] or None,
        "duration": round(float(fmt.get("duration") or 0), 2) or None,
        "bitrate": int(fmt.get("bit_rate") or 0) or None,
    }
    if v:
        w, h = v.get("width"), v.get("height")
        out.update({
            "width": w, "height": h, "res": display_res(w, h) or None,
            "vcodec": codec_name(v.get("codec_name")) or (v.get("codec_name") or "").upper() or None,
            "fps": _fps(v.get("avg_frame_rate")) or _fps(v.get("r_frame_rate")),
            "hdr": v.get("color_transfer") in ("smpte2084", "arib-std-b67"),
        })
    if a:
        out.update({
            "acodec": (a.get("codec_name") or "").upper() or None,
            "audio_bitrate": int(a.get("bit_rate") or 0) or None,
            "sample_rate": int(a.get("sample_rate") or 0) or None,
            "channels": a.get("channels"),
        })
    return out


class _Skipped(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _PlanPP(PostProcessor):
    """Runs right before the download starts: records which formats (parts) will be fetched, refuses silent
    quality downgrades and checks free disk space."""

    def __init__(self, job: "Job", plan: dict):
        super().__init__(None)
        self.job = job
        self.plan = plan

    def run(self, info):
        req = info.get("requested_formats") or [info]
        self.plan["parts"] = [
            {"size": int(f.get("filesize") or f.get("filesize_approx") or 0),
             "video": f.get("vcodec") not in (None, "none"), "audio": f.get("acodec") not in (None, "none")}
            for f in req
        ]
        self.plan["duration"] = info.get("duration")
        vf = next((f for f in req if f.get("vcodec") not in (None, "none")), None)
        af = next((f for f in req if f.get("acodec") not in (None, "none")), None)
        if vf:
            self.plan["source"] = {
                "width": vf.get("width"), "height": vf.get("height"), "fps": vf.get("fps"),
                "vcodec": codec_name(vf.get("vcodec")) or vf.get("vcodec"), "format_id": vf.get("format_id"),
                "dynamic_range": vf.get("dynamic_range"),
                "abr": (af or {}).get("abr"), "acodec": (af or {}).get("acodec"),
            }
        if self.job.kind == "video" and self.job.quality.isdigit() and vf:
            want = int(self.job.quality)
            w, h = vf.get("width"), vf.get("height")
            got = min(w, h) if (w and h) else (h or w or 0)
            if got and got < want * 0.85:
                self.plan["quality_error"] = (want, got, display_res(w, h))
                raise DownloadError(f"quality_unavailable: requested {want}, best available {got}")
        est = sum(p["size"] for p in self.plan["parts"])
        o = self.job.options or {}
        start, end, dur = o.get("trim_start_s"), o.get("trim_end_s"), info.get("duration")
        if (start is not None or end is not None) and dur:
            clip = min(end if end is not None else dur, dur) - (start or 0)
            est = int(est * max(0.02, clip / dur))  # only the selected section is downloaded
        try:
            free = shutil.disk_usage(settings.data_dir).free
        except OSError:
            free = 0
        if free and est and free - est * 1.15 < settings.min_free_disk_mb * MB:
            raise DownloadError("disk_full: not enough free space for this file")
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
    kind: str  # video | audio | gallery | convert
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
    warning: str = ""
    media: dict = field(default_factory=dict)
    source: dict = field(default_factory=dict)
    created: float = field(default_factory=time.time)
    started: float = 0.0
    finished: float = 0.0
    cancel_requested: bool = False
    pause_requested: bool = False
    attempts: int = 0
    run_token: int = 0
    served: int = 0
    details: list = field(default_factory=list)

    @property
    def pausable(self) -> bool:
        return self.kind in PAUSABLE_KINDS and self.status in {"queued", "preparing", "downloading"}

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
            "warning": self.warning,
            "media": self.media or None,
            "source": self.source or None,
            "pausable": self.pausable,
            "retryable": self.status in ("error", "cancelled") and self.kind != "convert",
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
        self._submit(job)
        return job

    def _submit(self, job: Job) -> None:
        job.run_token += 1
        self.executor.submit(self._run, job, job.run_token)

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
        if job.status in ACTIVE or job.status == "paused":
            job.cancel_requested = True
            if job.status in ("queued", "paused"):
                self._mark_cancelled(job)
                shutil.rmtree(settings.download_dir / job.id, ignore_errors=True)
        return job

    def pause(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise MediaError("Job not found or expired", "not_found", 404)
        if not job.pausable:
            raise MediaError("This download can't be paused right now.", "not_pausable", 409)
        if job.status == "queued":
            job.status = job.stage = "paused"
            job.run_token += 1  # the queued run will exit immediately
        else:
            job.pause_requested = True
        return job

    def resume(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise MediaError("Job not found or expired", "not_found", 404)
        if job.status != "paused":
            raise MediaError("This download isn't paused.", "not_paused", 409)
        job.pause_requested = job.cancel_requested = False
        job.status = job.stage = "queued"
        job.speed = job.eta = None
        self._submit(job)
        return job

    def retry(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise MediaError("Job not found or expired", "not_found", 404)
        if job.status not in ("error", "cancelled") or job.kind == "convert":
            raise MediaError("Only failed or cancelled downloads can be retried.", "not_retryable", 409)
        job.status = job.stage = "queued"
        job.error = job.error_code = job.warning = ""
        job.progress, job.downloaded, job.total = 0.0, 0, 0
        job.speed = job.eta = None
        job.finished = 0.0
        job.cancel_requested = job.pause_requested = False
        job.attempts = 0
        self._submit(job)
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
                if (j.status in DONE and j.finished and now - j.finished > ttl)
                or (j.status == "paused" and now - j.created > max(ttl * 2, 3600))
                or (now - j.created > max(ttl * 6, 7200))
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
        for base, max_age in ((settings.tmp_dir, 3600), (settings.upload_dir, ttl)):
            for d in base.iterdir():
                try:
                    if now - d.stat().st_mtime > max_age:
                        shutil.rmtree(d, ignore_errors=True) if d.is_dir() else d.unlink(missing_ok=True)
                except OSError:
                    pass

    def shutdown(self) -> None:
        for j in list(self.jobs.values()):
            j.cancel_requested = True
        self.executor.shutdown(wait=False, cancel_futures=True)

    def admin_list(self) -> list[dict]:
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)[:100]
        return [{
            "id": j.id, "platform": j.platform, "kind": j.kind, "label": j.label, "title": (j.title or "")[:90],
            "status": j.status, "stage": j.stage, "progress": round(j.progress, 1), "speed": j.speed,
            "filesize": j.filesize or j.total, "created": j.created, "finished": j.finished or None,
            "error_code": j.error_code or None,
        } for j in jobs]

    # ------------------------------------------------------------------ worker
    def _mark_cancelled(self, job: Job) -> None:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.speed = job.eta = None
        job.finished = time.time()

    def _stop_requested(self, job: Job) -> bool:
        return job.cancel_requested or job.pause_requested

    def _run(self, job: Job, token: int) -> None:
        if token != job.run_token or job.cancel_requested or job.status in ("cancelled", "paused"):
            return
        job.status, job.stage = "preparing", "preparing"
        job.started = job.started or time.time()
        job_dir = settings.download_dir / job.id
        job_dir.mkdir(parents=True, exist_ok=True)
        area = {"gallery": "gallery", "convert": "convert"}.get(job.kind, "download")
        while True:
            try:
                self._check_disk()
                if job.kind == "gallery":
                    path = self._run_gallery(job, job_dir)
                elif job.kind == "convert":
                    from .tools import run_convert
                    path = run_convert(job, job_dir, lambda: job.cancel_requested)
                else:
                    path = self._download(job, job_dir)
                    if self._stop_requested(job):
                        raise DownloadCancelled("stopped")
                    path = self._ensure_mp3_bitrate(job, path)
                    self._verify_output(job, path)
                job.filepath = str(path)
                job.filesize = path.stat().st_size
                if not job.filename:
                    job.filename = self._display_name(job, path)
                job.progress = 100.0
                job.speed = job.eta = None
                job.status = job.stage = "finished"
                job.finished = time.time()
                self.stats["completed"] += 1
                self.stats["bytes"] += job.filesize
                monitor.result(area, job.platform, True)
                return
            except DownloadCancelled:
                break
            except Exception as e:  # noqa: BLE001
                if job.pause_requested and not job.cancel_requested:
                    break
                if job.cancel_requested:
                    break
                if isinstance(e, (MediaError, _Skipped)):
                    code, msg = getattr(e, "code", "failed"), e.message
                else:
                    code, msg = humanize_error(str(e))
                if code in TRANSIENT_CODES and job.attempts < settings.auto_retries:
                    job.attempts += 1
                    job.status, job.stage = "preparing", "retrying"
                    job.speed = job.eta = None
                    time.sleep(3)
                    continue  # partial files are kept → resume
                self._fail(job, code, msg)
                monitor.result(area, job.platform, False)
                monitor.error(area, job.platform, code, msg, job.url, job.details)
                shutil.rmtree(job_dir, ignore_errors=True)
                return
        # stopped by the user
        if job.pause_requested and not job.cancel_requested:
            job.pause_requested = False
            job.status = job.stage = "paused"
            job.speed = job.eta = None
        else:
            self._mark_cancelled(job)
            shutil.rmtree(job_dir, ignore_errors=True)

    @staticmethod
    def _check_disk() -> None:
        try:
            free = shutil.disk_usage(settings.data_dir).free
        except OSError:
            return
        if free < settings.min_free_disk_mb * MB:
            raise MediaError("The server is low on disk space right now. Please try again in a few minutes.",
                             "disk_full")

    def _fail(self, job: Job, code: str, message: str) -> None:
        job.status = job.stage = "error"
        job.error_code = code
        job.error = message
        job.speed = job.eta = None
        job.finished = time.time()
        self.stats["failed"] += 1

    # ------------------------------------------------------------------ verification
    def _verify_output(self, job: Job, path: Path) -> None:
        """Never present a broken/incomplete file as a success."""
        if not path.exists() or path.stat().st_size == 0:
            raise MediaError("The download produced an empty file. Please try again.", "incomplete")
        probe = ffprobe(path)
        if not probe:
            raise MediaError("The downloaded file could not be read (FFmpeg verification failed). Please try again.",
                             "ffmpeg_failed")
        summary = media_summary(probe)
        plan = getattr(job, "_plan", {}) or {}
        parts = plan.get("parts") or []
        o = job.options or {}
        if job.kind == "video":
            if not summary.get("width"):
                raise MediaError("The file has no video track — processing failed. Please try again.", "ffmpeg_failed")
            if any(p.get("audio") for p in parts) and not summary.get("acodec"):
                raise MediaError("Merging the audio track failed (the file has no sound). Please try again.",
                                 "ffmpeg_failed")
        elif job.kind == "audio" and not summary.get("acodec"):
            raise MediaError("The file has no audio track — conversion failed. Please try again.", "ffmpeg_failed")
        dur = plan.get("duration")
        start, end = o.get("trim_start_s"), o.get("trim_end_s")
        if start is not None or end is not None:
            limits = [x for x in (end, dur) if x is not None]
            expected = (min(limits) - (start or 0)) if limits else None
        else:
            expected = dur
        got = summary.get("duration")
        if expected and got and not o.get("sponsorblock") and got < expected * 0.9 - 2:
            raise MediaError(f"The download was incomplete ({int(got)}s of {int(expected)}s). Please try again.",
                             "incomplete")
        job.media = summary
        src = plan.get("source") or {}
        if src:
            job.source = {k: v for k, v in src.items() if v not in (None, "")}

    # ------------------------------------------------------------------ yt-dlp downloads
    def _ensure_mp3_bitrate(self, job: Job, path: Path) -> Path:
        """yt-dlp stream-copies when the source is already MP3 (e.g. TikTok sounds), ignoring the requested
        bitrate. Re-encode so the file matches what the user picked (cover art + tags are preserved)."""
        preset = AUDIO_PRESETS.get(job.quality) or {}
        if job.kind != "audio" or preset.get("codec") != "mp3" or not preset.get("kbps") or path.suffix.lower() != ".mp3":
            return path
        probe = ffprobe(path)
        streams = probe.get("streams", [])
        audio = next((st for st in streams if st.get("codec_type") == "audio"), {})
        try:
            current = int(float(audio.get("bit_rate") or 0)) // 1000
        except ValueError:
            current = 0
        has_cover = any(st.get("codec_type") == "video" for st in streams)
        if not current or abs(current - preset["kbps"]) <= 16:
            return path
        job.status, job.stage = "processing", "converting"
        tmp = path.with_name("media.reencode.mp3")
        cmd = [tool("ffmpeg"), "-y", "-v", "error", "-i", str(path), "-map", "0:a:0"]
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

    def _download(self, job: Job, job_dir: Path) -> Path:
        cached = None if job.playlist_index else info_cache.get(job.url)
        first_clients = (cached or {}).get("_mg_clients")
        first_cookies = (cached or {}).get("_mg_cookies")
        plan: list[tuple[str, Attempt]] = []
        if cached:
            plan.append(("cache", Attempt(first_clients, bool(first_cookies) if first_cookies is not None
                                          else has_cookies(job.platform))))
        plan += [("fresh", a) for a in youtube_attempts(job.platform, first_clients, first_cookies)]

        last_error, quality = "", None
        for mode, att in plan:
            try:
                return self._attempt(job, job_dir, mode, att, cached)
            except (DownloadCancelled, _Skipped):
                raise
            except DownloadError as e:
                last_error = str(e)
                quality = (getattr(job, "_plan", {}) or {}).get("quality_error") or quality
                if self._stop_requested(job):
                    raise DownloadCancelled("stopped") from None
                self._reset(job, job_dir)
                code, _ = humanize_error(last_error)
                if code in ("too_large", "cancelled", "private", "unavailable", "unsupported", "disk_full", "live",
                            "age_restricted", "geo_blocked"):
                    break
                if mode == "cache":
                    continue  # cached stream URLs may have expired → fresh extraction
                if job.platform == "youtube" and (is_youtube_retryable(last_error) or "quality_unavailable" in last_error):
                    continue  # another player client / no cookies may work
                break
        if quality and "quality_unavailable" in last_error:
            want, got, got_label = quality
            raise MediaError(
                f"{want}p isn't available for this video right now — the best the source offers is {got_label}p. "
                f"Please choose {got_label}p or try again later.", "quality_unavailable")
        if "disk_full" in last_error:
            raise MediaError("The server doesn't have enough free space for this file right now.", "disk_full")
        code, msg = humanize_error(last_error or "Download failed")
        raise MediaError(msg, code)

    def _attempt(self, job: Job, job_dir: Path, mode: str, att: Attempt, cached: dict | None) -> Path:
        logger = CollectLogger()
        final_files: list[str] = []
        skip: dict[str, str] = {}
        plan: dict = {"parts": []}
        job._plan = plan  # type: ignore[attr-defined]
        try:
            with private_cookies(job.platform, job_dir, enabled=att.cookies) as cookiefile:
                opts = self._build_opts(job, logger, att.clients, skip)
                opts["paths"] = {"home": str(job_dir), "temp": str(job_dir)}
                if cookiefile:
                    opts["cookiefile"] = cookiefile
                opts["progress_hooks"] = [self._progress_hook(job, plan)]
                opts["postprocessor_hooks"] = [self._pp_hook(job)]
                opts["post_hooks"] = [final_files.append]
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.add_post_processor(_PlanPP(job, plan), when="before_dl")
                    if mode == "cache" and cached is not None:
                        ydl.process_ie_result(cached, download=True)
                    else:
                        ydl.download([job.url])
        except DownloadError:
            job.details = logger.details()
            raise
        if self._stop_requested(job):
            raise DownloadCancelled("stopped")
        if skip:
            raise _Skipped(skip["code"], skip["message"])
        path = self._resolve_output(final_files, job_dir)
        if path:
            return path
        job.details = logger.details()
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
            "continuedl": True,
        })
        if settings.max_filesize_mb:
            opts["max_filesize"] = settings.max_filesize_mb * MB

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
            if job.cancel_requested or job.pause_requested:
                raise DownloadCancelled("stopped by user")
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

    # ------------------------------------------------------------------ photos / carousel items
    def _run_gallery(self, job: Job, job_dir: Path) -> Path:
        from .detect import get_gallery
        from .gallery import StopDownload, build_zip, download_media, item_filename, zip_name

        g = get_gallery(job.url)
        wanted = set(job.options.get("items") or [])
        items = [it for it in g["items"] if not wanted or it["index"] in wanted]
        if not items:
            raise MediaError("Nothing to download — please select at least one item.", "no_media")
        if not job.title or job.title.startswith("http"):
            job.title = (g.get("title") or "")[:200]
        if not job.thumbnail:
            job.thumbnail = proxied_image(next((i.get("preview") for i in items if i.get("preview")), None))
        single = len(items) == 1
        max_bytes = settings.max_filesize_mb * MB if settings.max_filesize_mb else 0
        files: list[tuple[Path, str]] = []
        t0, bytes_before = time.time(), 0
        stop = lambda: self._stop_requested(job)  # noqa: E731
        try:
            for k, it in enumerate(items):
                name = item_filename(g, it, single)
                existing = [p for p in job_dir.glob(f"{it['index']:03d}.*") if p.suffix != ".part"]
                if existing:  # resumed job: already downloaded
                    files.append((existing[0], f"{name}{existing[0].suffix}"))
                    bytes_before += existing[0].stat().st_size
                    continue
                job.status, job.stage = "downloading", "downloading"

                def on_progress(done: int, total: int, k: int = k) -> None:
                    frac = min(1.0, done / total) if total else 0.5
                    job.progress = max(job.progress, min(99.0, round((k + frac) / len(items) * 100, 1)))
                    job.downloaded = bytes_before + done
                    elapsed = max(0.5, time.time() - t0)
                    job.speed = job.downloaded / elapsed
                    remaining_items = len(items) - k - frac
                    per_item = job.downloaded / max(0.5, k + frac)
                    job.eta = int(remaining_items * per_item / job.speed) if job.speed else None
                    job.total = int(per_item * len(items)) if per_item else 0

                path = download_media(it["url"], job_dir / f"{it['index']:03d}", g.get("referer"), max_bytes,
                                      on_progress, stop, expect=it["type"])
                bytes_before += path.stat().st_size
                files.append((path, f"{name}{path.suffix}"))
            job.speed = job.eta = None
            images = [p for p, _ in files if p.suffix.lower() in (".jpg", ".png", ".webp", ".gif", ".avif", ".heic", ".bmp")]
            job.media = {"items": len(files), "images": len(images), "videos": sum(1 for p, _ in files if p.suffix in (".mp4", ".mov", ".webm")),
                         "audio": sum(1 for p, _ in files if p.suffix in (".mp3", ".m4a", ".ogg", ".aac"))}
            if single:
                path, display = files[0]
                dims = image_dimensions(path)
                if dims:
                    job.media.update({"width": dims[0], "height": dims[1], "format": path.suffix.lstrip(".").upper()})
                elif path.suffix in (".mp4", ".mov", ".webm", ".mp3", ".m4a"):
                    job.media.update(media_summary(ffprobe(path)))
                job.filename = display
                return path
            job.status, job.stage = "processing", "zipping"
            out = build_zip(files, job_dir / "photos.zip", stop)
            for p, _ in files:
                p.unlink(missing_ok=True)
            job.filename = zip_name(g, len(files))
            return out
        except StopDownload:
            raise DownloadCancelled("stopped") from None

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
