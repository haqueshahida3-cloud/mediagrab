"""In-memory monitoring for the admin dashboard.

Error log, success/failure counters, rate-limit statistics and system resources. Nothing is written to disk
and no IP addresses are stored — everything disappears on restart.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from collections import Counter, deque
from pathlib import Path

from .config import settings


def _read(path: str) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def _redact_url(url: str | None) -> str | None:
    """Keep enough of the URL to debug (host + path + video id) but drop tracking params / tokens."""
    if not url:
        return None
    url = re.sub(r"([?&])(si|igsh|igshid|fbclid|utm_[a-z]+|token|sig|signature|oh|oe|_nc_[a-z]+)=[^&]*", r"\1", url)
    url = re.sub(r"[?&]+$", "", url.replace("?&", "?"))
    return url[:220]


class Monitor:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.started = time.time()
        self.errors: deque[dict] = deque(maxlen=200)
        self.counters: Counter[str] = Counter()
        self.platforms: dict[str, Counter[str]] = {}
        self.rate_limited: Counter[str] = Counter()
        self.notices: dict[str, dict] = {}
        self._cpu_prev: tuple[float, float] | None = None
        self._versions: dict[str, str] | None = None

    # ------------------------------------------------------------------ recording
    def count(self, key: str, n: int = 1) -> None:
        with self.lock:
            self.counters[key] += n

    def result(self, area: str, platform: str, ok: bool) -> None:
        """area: info | download | gallery | convert"""
        with self.lock:
            self.counters[f"{area}.{'ok' if ok else 'fail'}"] += 1
            c = self.platforms.setdefault(platform or "other", Counter())
            c[f"{area}.{'ok' if ok else 'fail'}"] += 1

    def error(self, area: str, platform: str, code: str, message: str,
              url: str | None = None, details: list[str] | None = None) -> None:
        entry = {
            "time": time.time(),
            "area": area,
            "platform": platform or "other",
            "code": code,
            "message": (message or "")[:400],
            "url": _redact_url(url),
            "details": [re.sub(r"\s+", " ", d)[:300] for d in (details or [])][-6:],
        }
        with self.lock:
            self.errors.appendleft(entry)

    def rate_limit(self, bucket: str) -> None:
        with self.lock:
            self.rate_limited[bucket] += 1

    def notice(self, key: str, level: str, message: str) -> None:
        with self.lock:
            self.notices[key] = {"level": level, "message": message, "time": time.time()}

    def clear_notice(self, key: str) -> None:
        with self.lock:
            self.notices.pop(key, None)

    # ------------------------------------------------------------------ system
    def versions(self) -> dict[str, str]:
        if self._versions is None:
            out: dict[str, str] = {}
            ff = settings.ffmpeg_location or shutil.which("ffmpeg") or "ffmpeg"
            if Path(ff).is_dir():
                ff = str(Path(ff) / "ffmpeg")
            for name, cmd in (("ffmpeg", [ff, "-hide_banner", "-version"]), ("deno", ["deno", "--version"])):
                try:
                    line = subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
                    out[name] = line.replace("ffmpeg version ", "").split(" Copyright")[0].strip()[:80]
                except (OSError, IndexError, subprocess.SubprocessError):
                    out[name] = ""
            self._versions = out
        return self._versions

    def system(self) -> dict:
        info: dict = {"pid": os.getpid(), "cpus": os.cpu_count() or 1}
        try:
            info["load"] = [round(x, 2) for x in os.getloadavg()]
        except OSError:
            info["load"] = None
        # Memory: prefer the container (cgroup v2) limit — that's what matters on Render/Docker
        mem_total = mem_avail = None
        for line in _read("/proc/meminfo").splitlines():
            if line.startswith("MemTotal:"):
                mem_total = int(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                mem_avail = int(line.split()[1]) * 1024
        cg_max, cg_cur = _read("/sys/fs/cgroup/memory.max"), _read("/sys/fs/cgroup/memory.current")
        if cg_max.isdigit() and cg_cur.isdigit() and (mem_total is None or int(cg_max) < mem_total):
            info["memory"] = {"total": int(cg_max), "used": int(cg_cur), "scope": "container"}
        elif mem_total:
            info["memory"] = {"total": mem_total, "used": mem_total - (mem_avail or 0), "scope": "host"}
        rss = re.search(r"VmRSS:\s+(\d+)", _read("/proc/self/status"))
        info["process_rss"] = int(rss.group(1)) * 1024 if rss else None
        # CPU usage of the container since the previous call (cgroup v2), as a % of the CPU quota
        usage = re.search(r"usage_usec (\d+)", _read("/sys/fs/cgroup/cpu.stat"))
        quota = _read("/sys/fs/cgroup/cpu.max").split()
        cpus = info["cpus"]
        if len(quota) == 2 and quota[0].isdigit():
            cpus = max(0.01, int(quota[0]) / int(quota[1]))
        info["cpu_limit"] = round(cpus, 2)
        if usage:
            now, used = time.monotonic(), int(usage.group(1)) / 1e6
            if self._cpu_prev:
                dt, du = now - self._cpu_prev[0], used - self._cpu_prev[1]
                info["cpu_percent"] = round(min(100.0, max(0.0, du / dt / cpus * 100)), 1) if dt > 0 else None
            self._cpu_prev = (now, used)
        try:
            du = shutil.disk_usage(settings.data_dir)
            info["disk"] = {"total": du.total, "used": du.used, "free": du.free}
        except OSError:
            info["disk"] = None
        info["uptime"] = int(time.time() - self.started)
        return info

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "counters": dict(self.counters),
                "platforms": {k: dict(v) for k, v in self.platforms.items()},
                "rate_limited": dict(self.rate_limited),
                "notices": dict(self.notices),
                "errors": list(self.errors),
            }


monitor = Monitor()
