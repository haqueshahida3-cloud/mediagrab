<div align="center">

<img src="static/icons/icon-192.png" width="84" alt="MediaGrab logo">

# MediaGrab

**All-in-one social video downloader — YouTube, Facebook, Instagram, X (Twitter) & TikTok**
HD / 4K / 8K MP4 · MP3 up to 320 kbps · playlists · batch · trim · subtitles · no watermark

![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)
![yt-dlp](https://img.shields.io/badge/powered%20by-yt--dlp-red)
![FFmpeg](https://img.shields.io/badge/FFmpeg-merge%20%26%20convert-007808?logo=ffmpeg&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-purple)

<img src="docs/screenshots/home.png" alt="MediaGrab home" width="860">

</div>

---

## ✨ Features

| | |
|---|---|
| 🎬 **Every quality** | 144p → 8K, 60 fps & HDR, with real file-size estimates and codec info |
| 🎵 **Audio converter** | MP3 320/256/192/128 kbps, M4A, OPUS, FLAC, WAV — cover art + tags embedded |
| 🚫 **No watermark** | TikTok videos in the original quality, without watermark |
| 📃 **Playlists & carousels** | Load a whole YouTube playlist / Instagram carousel / multi-video post, pick items, download with a smart client-side queue |
| 📥 **Batch mode** | Paste dozens of links (one per line) with one quality preset |
| ✂️ **Trim / clip** | Download only a section (start/end or chapter picker), optional frame-accurate cut |
| 💬 **Subtitles** | Download SRT/VTT (manual, auto-generated and auto-translated — incl. Bangla) or embed into the MP4 |
| ⏭️ **SponsorBlock** | Remove sponsor / intro / self-promo segments from YouTube videos |
| 🖼️ **Thumbnails** | Grab cover images in every available resolution |
| 📊 **Live queue** | Real progress (video → audio → merge → convert), speed, ETA, cancel, retry, preview, auto-save |
| 📱 **PWA** | Installable app, offline shell, Android **share-target** (share from the YouTube/TikTok app straight to MediaGrab) |
| 🌐 **Bilingual UI** | English & বাংলা (Bangla digits & number formatting), dark/light theme, fully responsive |
| ⌨️ **Power-user UX** | Paste anywhere (Ctrl+V), drag & drop links, `Ctrl+K`, `?url=` deep links, one-click bookmarklet, history, settings |
| 🛡️ **Production-ready backend** | SSRF protection, per-IP rate limits & job quotas, auto-cleanup, HMAC-signed thumbnail proxy, YouTube bot-check fallbacks, per-platform cookies, proxy support, Docker, health checks, tests & CI |

<p align="center">
  <img src="docs/screenshots/result.png" alt="Quality picker" width="49%">
  <img src="docs/screenshots/downloads.png" alt="Download queue" width="49%">
</p>
<p align="center"><img src="docs/screenshots/mobile-bn.png" alt="Mobile – Bangla" width="260"></p>

---

## 🚀 Quick start

### Option A — Docker (recommended)

```bash
docker compose up -d --build
# open http://localhost:8000
```

### Option B — Local Python

Requirements: **Python 3.11+**, **FFmpeg**, and (recommended for YouTube) **Deno**.

```bash
# macOS:   brew install ffmpeg deno
# Ubuntu:  sudo apt install ffmpeg && curl -fsSL https://deno.land/install.sh | sh
# Windows: winget install Gyan.FFmpeg DenoLand.Deno

python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # optional
./run.sh                                               # or: uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000> — the interactive API docs live at <http://localhost:8000/api/docs>.

---

## ☁️ Deployment

MediaGrab needs a **long-running server** (downloads run in background workers, FFmpeg merges files on disk).

| Platform | How |
|---|---|
| **Render** | *New → Blueprint* → pick this repo (uses `render.yaml` + `Dockerfile`) |
| **Railway / Fly.io / Koyeb** | Deploy from the repo — the `Dockerfile` is detected automatically. Set `PORT` if required |
| **VPS (DigitalOcean, Hetzner, Contabo…)** | `git clone … && docker compose up -d --build`, then put Nginx/Caddy + HTTPS in front |

> ⚠️ **Why not Vercel / Netlify?** Serverless functions have short time limits, a ~4.5 MB response limit,
> no shared memory between requests (the job queue) and no FFmpeg. Use one of the options above.

**Recommended sizing:** 1 vCPU / 1 GB RAM handles a few concurrent downloads. 4K merges and FLAC/WAV conversion are CPU-heavy — raise resources or lower `MAX_CONCURRENT_DOWNLOADS`.

> Keep **one** uvicorn worker (`WEB_CONCURRENCY=1`): jobs live in process memory. Scale up with more
> threads (`MAX_CONCURRENT_DOWNLOADS`) or more instances with sticky sessions.

---

## ⚙️ Configuration

All settings are environment variables — see [`.env.example`](.env.example) for the full, commented list.

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | auto | Signs thumbnail-proxy URLs (set it in production) |
| `FILE_TTL_MINUTES` | `30` | Finished files are deleted after this time |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Parallel download workers |
| `MAX_JOBS_PER_IP` | `25` | Queued + running jobs per visitor |
| `MAX_FILESIZE_MB` | `2048` | Refuse bigger files (`0` = unlimited) |
| `MAX_DURATION_MINUTES` | `240` | Longer videos must be trimmed (`0` = unlimited) |
| `MAX_PLAYLIST_ITEMS` | `100` | Playlist entries loaded |
| `RATE_LIMIT_INFO` / `RATE_LIMIT_DOWNLOAD` | `40` / `30` | Requests per minute per IP |
| `PROXY` | – | HTTP/SOCKS proxy for all platform requests |
| `COOKIES_DIR` | `./cookies` | Per-platform cookie files (`youtube.txt`, `instagram.txt`, …) |
| `YTDLP_AUTO_UPDATE` | `true` | Docker: upgrade yt-dlp on every start |
| `YOUTUBE_CLIENTS` / `YOUTUBE_FALLBACK_CLIENTS` | see file | YouTube player clients & bot-check fallbacks |

### Cookies (optional)
Public content works without login. For age-restricted / private / login-only content — or if YouTube
shows *"Sign in to confirm you're not a bot"* on your server — add cookie files. See [`cookies/README.md`](cookies/README.md).

---

## 🔌 API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/info` | `{url, playlist?}` → title, uploader, stats, video/audio options, thumbnails, subtitles, chapters (or playlist entries) |
| `POST` | `/api/download` | `{url, kind: video\|audio, quality, options{trim_start, trim_end, precise_cut, sponsorblock, embed_subs, sub_lang, prefer_h264, embed_metadata, filename}, playlist_index?}` → job |
| `GET` | `/api/jobs?ids=a,b` | Batch job status (progress, stage, speed, ETA) |
| `GET` | `/api/jobs/{id}` | Single job status |
| `DELETE` | `/api/jobs/{id}` | Cancel / remove a job |
| `GET` | `/api/jobs/{id}/file` | Download the finished file (`?inline=1` to stream/preview, supports Range) |
| `POST` | `/api/subtitles` | `{url, lang, auto, fmt: srt\|vtt}` → subtitle file |
| `GET` | `/api/thumb` | Signed thumbnail proxy |
| `GET` | `/api/health` · `/api/config` | Health/stats · public limits |

```bash
curl -s -X POST localhost:8000/api/download -H 'content-type: application/json' \
  -d '{"url":"https://youtu.be/jNQXAC9IVRw","kind":"audio","quality":"mp3-320"}'
```

---

## 🗂️ Project structure

```
app/
  main.py        FastAPI routes, validation, thumbnail proxy, static frontend
  ytdl.py        yt-dlp options, friendly errors, cookies, YouTube fallbacks, info cache
  media.py       Normalises formats → quality list, audio presets, thumbnails, subtitles, playlists
  jobs.py        Background job manager: queue, progress, cancel, cleanup
  extras.py      Subtitle download/conversion
  ratelimit.py   Sliding-window rate limiter
  utils.py       Platform detection, SSRF-safe URL validation, filenames, signing
  config.py      Environment settings
static/          index.html, css/style.css, js/app.js, js/i18n.js, js/icons.js, sw.js, manifest
tests/           pytest suite (network-free)
```

Run tests: `pip install -r requirements-dev.txt && pytest -q`

---

## 🛠️ Troubleshooting

* **A site suddenly stopped working** → update yt-dlp: `pip install -U "yt-dlp[default,curl-cffi]"` (Docker does this on start).
* **YouTube: "Sign in to confirm you're not a bot"** → common on cloud/datacenter IPs. MediaGrab automatically retries with other player clients; for a permanent fix add `cookies/youtube.txt` or set a residential `PROXY`.
* **Instagram/Facebook: "login required"** → the post is private/age-gated or the platform is rate-limiting the server IP; add cookies.
* **FFmpeg not found** → install it or set `FFMPEG_LOCATION`. `GET /api/health` shows what the server detects.

---

## 🇧🇩 বাংলায় দ্রুত গাইড

1. **লোকালি চালাতে:** Python 3.11+, FFmpeg ও Deno ইনস্টল করুন → `pip install -r requirements.txt` → `./run.sh` → ব্রাউজারে `http://localhost:8000` খুলুন।
2. **Docker দিয়ে:** `docker compose up -d --build` — ব্যস!
3. **অনলাইনে হোস্ট করতে:** Render (Blueprint), Railway বা যেকোনো VPS-এ Docker দিয়ে ডিপ্লয় করুন। Vercel-এ এটা চলবে না (লম্বা সময়ের ডাউনলোড ও FFmpeg লাগে)।
4. **YouTube-এ "Sign in to confirm you're not a bot" এলে:** `cookies/youtube.txt` ফাইল যোগ করুন (`cookies/README.md` দেখুন) অথবা `PROXY` সেট করুন।
5. **কোনো সাইট হঠাৎ কাজ না করলে:** yt-dlp আপডেট করুন — `pip install -U "yt-dlp[default,curl-cffi]"`।

---

## ⚖️ Legal

MediaGrab is a tool. Only download content you own, that is in the public domain, or that you have
permission to download, and respect each platform's Terms of Service and your local copyright law.
The authors are not responsible for misuse.

## 📄 License

[MIT](LICENSE)
