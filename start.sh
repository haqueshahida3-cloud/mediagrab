#!/bin/sh
# Container entrypoint. Optionally refreshes yt-dlp on boot — platforms change often and
# an outdated yt-dlp is the #1 cause of "this link doesn't work anymore".
set -e
if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  echo "[start] updating yt-dlp…"
  pip install --user --quiet --upgrade "yt-dlp[default,curl-cffi]" 2>/dev/null \
    && python -c "import yt_dlp; print('[start] yt-dlp', yt_dlp.version.__version__)" \
    || echo "[start] yt-dlp update skipped (offline?)"
fi
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" \
  --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 30
