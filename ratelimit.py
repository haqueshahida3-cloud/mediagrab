"""Tiny in-memory sliding-window rate limiter (per client IP). Blocked requests are counted for the dashboard."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException

from .monitor import monitor


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window: float = 60.0) -> float:
        """Register a hit. Returns 0 when allowed, otherwise seconds until a slot frees up."""
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                return max(1.0, window - (now - q[0]))
            q.append(now)
            return 0.0

    def enforce(self, key: str, limit: int, window: float = 60.0) -> None:
        if limit <= 0:
            return
        retry = self.hit(key, limit, window)
        if retry:
            monitor.rate_limit(key.split(":", 1)[0])
            raise HTTPException(
                status_code=429,
                detail=f"Too many requests — please wait {int(retry)} seconds and try again.",
                headers={"Retry-After": str(int(retry) + 1)},
            )

    def prune(self, window: float = 300.0) -> None:
        now = time.monotonic()
        with self._lock:
            for key in [k for k, q in self._hits.items() if not q or q[-1] <= now - window]:
                self._hits.pop(key, None)

    def tracked(self) -> int:
        with self._lock:
            return len(self._hits)


limiter = RateLimiter()
