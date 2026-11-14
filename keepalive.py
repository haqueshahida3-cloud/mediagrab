"""Keep-awake ping: free Render services sleep after ~15 minutes without traffic. When enabled, the app requests its
own /api/health every few minutes so the first visitor never waits for a cold start."""
from __future__ import annotations

import asyncio
import logging

import httpx

from .config import settings

log = logging.getLogger("mediagrab.keepalive")


async def keep_awake_loop() -> None:
    base = settings.base_url
    if not (settings.keep_awake and base.startswith("https://")):
        return
    url = f"{base}/api/health"
    log.info("keep-awake enabled: pinging %s every %s min", url, settings.keep_awake_minutes)
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        while True:
            await asyncio.sleep(settings.keep_awake_minutes * 60)
            try:
                await client.get(url)
            except httpx.HTTPError:
                pass  # offline / restarting — try again next round
