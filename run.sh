#!/usr/bin/env bash
# Start MediaGrab locally:  ./run.sh   (then open http://localhost:8000)
set -euo pipefail
cd "$(dirname "$0")"

# Use locally installed ffmpeg / deno if present
export PATH="$HOME/.local/bin:$HOME/.deno/bin:$PATH"
[ -f .env ] && set -a && . ./.env && set +a

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
WORKERS="${WEB_CONCURRENCY:-1}"   # keep 1: jobs live in process memory

exec python3 -m uvicorn app.main:app --host "$HOST" --port "$PORT" --workers "$WORKERS" \
  --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 30
