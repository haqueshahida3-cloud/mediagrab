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

COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Flat upload fix: put files back into their folders
RUN mkdir -p app static/css static/js static/icons scripts; \
    mv_if() { if [ ! -f "$2" ] && [ -f "$1" ]; then mv "$1" "$2"; fi; }; \
    for f in __init__.py config.py extras.py jobs.py main.py media.py ratelimit.py utils.py ytdl.py; do mv_if "$f" "app/$f"; done; \
    for f in index.html sw.js manifest.webmanifest; do mv_if "$f" "static/$f"; done; \
    mv_if style.css static/css/style.css; \
    for f in app.js i18n.js icons.js; do mv_if "$f" "static/js/$f"; done; \
    for f in favicon.svg icon-192.png icon-512.png maskable-512.png; do mv_if "$f" "static/icons/$f"; done; \
    mv_if start.sh scripts/start.sh; \
    mv_if run.sh scripts/run.sh; \
    missing=""; \
    for f in app/main.py static/index.html static/js/app.js static/css/style.css scripts/start.sh; do \
      [ -f "$f" ] || missing="$missing $f"; \
    done; \
    if [ -n "$missing" ]; then echo "ERROR - missing:$missing"; exit 1; fi; \
    sed -i 's/\r$//' scripts/start.sh \
 && useradd --create-home --uid 10001 app \
 && mkdir -p /data \
 && chown -R app:app /data /app
USER app

EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "scripts/start.sh"]
