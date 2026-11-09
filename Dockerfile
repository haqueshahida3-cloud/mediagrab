# ---- MediaGrab: FastAPI + yt-dlp + FFmpeg + Deno (for YouTube JS challenges)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data \
    PORT=8000

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Deno is the JavaScript runtime yt-dlp uses to solve YouTube's player challenges
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Uploading through GitHub's website can silently drop folders (always, from a phone).
# Stop here with a clear message instead of a cryptic error later on.
RUN missing=""; \
    for f in app/main.py static/index.html static/js/app.js static/css/style.css scripts/start.sh; do \
      [ -f "$f" ] || missing="$missing $f"; \
    done; \
    if [ -n "$missing" ]; then \
      echo "ERROR - missing from the repository:$missing"; \
      echo "Upload the whole project together with its folders (app/, static/, scripts/)."; \
      exit 1; \
    fi; \
    sed -i 's/\r$//' scripts/start.sh \
 && useradd --create-home --uid 10001 app \
 && mkdir -p /data \
 && chown -R app:app /data /app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health', timeout=4)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Run through sh so it works even if the script lost its executable bit (web uploads, Windows)
CMD ["sh", "scripts/start.sh"]
