<div align="center">

# MediaGrab

**Fast, private, honest media downloader** — videos in genuine HD / 4K / 8K, photos & carousels in original
quality, MP3 — from YouTube, Facebook, Instagram, X (Twitter), TikTok and 1000+ sites.

FastAPI · yt-dlp · FFmpeg · gallery-dl · vanilla JS PWA · English & বাংলা

![MediaGrab home](docs/screenshots/home.png)

</div>

## ✨ Features

**Downloads**
- **Media detection engine** — every link is classified as *video, audio, photo, carousel, album, playlist* or
  *mixed* and only genuinely available options are shown.
- **Photos** — Instagram posts & carousels (incl. mixed photo/video), TikTok **photo mode** (all images + sound),
  X photos (original `name=orig`), Facebook public posts & albums (up to 2048 px). Previews, single downloads
  or **ZIP**, original bytes (format & quality untouched), meaningful file names.
- **Real 144p → 8K** — only resolutions the source really has. Separate video/audio streams are merged with
  FFmpeg *without re-encoding*; every output is **verified with ffprobe** (tracks, duration, real resolution).
  Asking for a quality the source can't deliver fails *before* downloading — no silent downgrade, no fake 4K.
- **Audio** — MP3 320/256/192/128 (true bitrate), M4A, Opus, FLAC, WAV with cover art & tags.
- Playlists, batch mode, trim/clip, SponsorBlock, subtitles (SRT/VTT), chapters, thumbnails.

**Download manager** — real-time progress, MB/s, ETA, size · **pause / resume** (partial data kept) · cancel ·
**retry** (server-side, resumes where possible) · queue with parallel limit · auto-retry on network errors ·
output details (e.g. *2160p · 3840×2160 · VP9 · 60fps · AAC*) · history, recent files, clear history.

**Media Tools** (`/tools`) — video → MP3/WAV/M4A/FLAC/Opus (link or upload), audio extraction, thumbnail &
frame grabber, image downloader, **JPG ⇄ PNG ⇄ WebP converter** (in the browser, batch + ZIP), metadata viewer
(all formats of a link; file details, EXIF with GPS warning, ffprobe analysis).

**UX** — premium responsive UI, skeleton loading, toasts, empty/error states · themes **Light / Dark / AMOLED /
Gray / System**, accent colours (+ custom), backgrounds (aurora, mesh, grid, solid, *your own image*), reduced
motion · clipboard detection (with permission), paste-anywhere, drag & drop, keyboard shortcuts (`?`) ·
favourite platforms · **PWA** (install, offline shell, Android share target, shortcuts) · English & Bangla.

**Security & privacy** — strict CSP (no inline scripts), HSTS, frame protection, COOP, request-size limits,
optional HTTPS redirect, SSRF protection for user links *and* media CDNs, signed image proxy, per-IP rate limits,
safe temp files with automatic cleanup, no accounts, no trackers.

**SEO** — server-rendered pages (About, Platforms, How to use, FAQ, Contact, Privacy, Terms, DMCA, API docs),
canonical + hreflang (en/bn), Open Graph/Twitter cards, JSON-LD (WebApplication, FAQPage, HowTo, Organization),
`sitemap.xml`, `robots.txt`.

**Admin dashboard** (`/admin`, token-protected) — health, CPU/memory/disk, success rates, queue with cancel,
per-platform stats, rate-limit stats, cookie status, error log with yt-dlp diagnostics, FFmpeg/yt-dlp versions.

## 🚀 Quick start

### Docker (recommended)
```bash
docker compose up -d --build
# open http://localhost:8000
```

### Local Python
```bash
# needs Python 3.11+, FFmpeg and Deno (YouTube player challenges)
# macOS:   brew install ffmpeg deno
# Ubuntu:  sudo apt install ffmpeg && curl -fsSL https://deno.land/install.sh | sh
# Windows: winget install Gyan.FFmpeg DenoLand.Deno
pip install -r requirements.txt
cp .env.example .env        # optional
./run.sh                    # http://localhost:8000
```

## ☁️ Deployment

MediaGrab needs a **long-running server** (background jobs, FFmpeg on disk) — Render, Railway, Fly.io, Koyeb or
any VPS. *Vercel/Netlify serverless functions won't work* (time limits, ~4.5 MB responses, no shared job queue).

### Render
1. Push this folder to GitHub (all folders: `app/`, `static/`, `templates/`, `scripts/`, …).
2. Render → **New → Blueprint** → pick the repo (uses `render.yaml` + `Dockerfile`).
3. Set the prompted variables: `ADMIN_TOKEN` (long random string), `PUBLIC_BASE_URL`, `CONTACT_EMAIL`.
4. Optional cookies: **Environment → Secret Files** → `youtube.txt`, `facebook.txt`… (see `cookies/README.md`).

**Updating an existing Render service:** commit the new code to the same GitHub repo — Render redeploys
automatically (`autoDeploy`). Add the new variables (`ADMIN_TOKEN`, `PUBLIC_BASE_URL`, `CONTACT_EMAIL`,
`FORCE_HTTPS=true`) under *Environment*. Check `https://<your-app>/api/health` → `"version": "2.0.0"`.

### VPS
`git clone … && docker compose up -d --build`, then put Nginx/Caddy with HTTPS in front (keep `TRUST_PROXY=true`).

**Sizing:** 1 vCPU / 1 GB RAM handles several concurrent downloads. 4K/8K merges and FLAC/WAV conversion are
CPU- and disk-heavy; the free Render plan (0.1 CPU, 512 MB, sleeps when idle) works but is slow. Keep **one**
uvicorn worker — jobs live in process memory.

## ⚙️ Configuration

All settings are environment variables (see `.env.example`).

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | auto | Signs image-proxy URLs and admin sessions |
| `ADMIN_TOKEN` | — | Enables `/admin` (12+ chars). Empty = disabled |
| `PUBLIC_BASE_URL` | from request | Canonical URLs, sitemap, Open Graph |
| `CONTACT_EMAIL` | — | Shown on the Contact page |
| `DATA_DIR` | `/tmp/mediagrab` (`/data` in Docker) | Temporary files |
| `FILE_TTL_MINUTES` | 30 | Files & uploads are deleted after this |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Parallel server jobs |
| `MAX_JOBS_PER_IP` | 25 | Active jobs per visitor |
| `MAX_FILESIZE_MB` | 2048 | Per-file limit (0 = unlimited) |
| `MAX_DURATION_MINUTES` | 240 | Longer videos need Trim (0 = unlimited) |
| `MAX_PLAYLIST_ITEMS` / `MAX_GALLERY_ITEMS` | 100 / 100 | Items listed per playlist / post |
| `MAX_UPLOAD_MB` | 200 | Media Tools uploads |
| `MIN_FREE_DISK_MB` | 300 | Refuse new jobs below this free space |
| `AUTO_RETRIES` | 1 | Automatic job retries on network errors |
| `RATE_LIMIT_INFO` / `_DOWNLOAD` / `_TOOLS` | 40 / 30 / 20 | Requests per minute per IP |
| `INFO_CACHE_TTL` | 900 | Seconds detection results are reused |
| `PROXY` | — | `http://user:pass@host:port` or `socks5://…` |
| `TRUST_PROXY` | true | Honour `X-Forwarded-*` behind Render/Nginx/Cloudflare |
| `COOKIES_DIR` / `COOKIES_FILE` / `SECRET_FILES_DIR` | `./cookies` / — / `/etc/secrets` | Cookie files (see `cookies/README.md`) |
| `FORCE_HTTPS` | false | Redirect when the proxy reports plain HTTP |
| `ALLOW_FRAMING` | false | Allow iframes (dev previews only) |
| `MAX_JSON_BODY_KB` | 64 | JSON request limit |
| `YOUTUBE_CLIENTS` / `YOUTUBE_FALLBACK_CLIENTS` | `default,web_embedded` / `web_embedded,tv;mweb` | yt-dlp player clients |
| `JS_RUNTIMES` / `FFMPEG_LOCATION` / `YTDLP_AUTO_UPDATE` | `deno,node` / — / true | Tooling |

## 🔐 Admin dashboard

Set `ADMIN_TOKEN`, open `/admin` and sign in. The token is exchanged for an HttpOnly, SameSite=Strict session
cookie (8 h); login is rate-limited; changing the token logs everyone out; POST actions require a CSRF header.
Nothing in the dashboard is persisted and no IP addresses are stored.

## 🔌 API

Human-readable docs at **`/api-docs`**, interactive Swagger at **`/api/docs`**. Main endpoints:
`POST /api/info`, `POST /api/formats`, `POST /api/download` (`kind`: video | audio | gallery),
`GET /api/jobs/{id}`, `POST /api/jobs/{id}/pause|resume|retry|cancel`, `GET /api/jobs/{id}/file`,
`POST /api/tools/upload|probe|convert`, `GET /api/health`.

## 🗂️ Project structure

```
app/
  main.py      API routes, thumbnail proxy (resized previews), Media Tools endpoints
  detect.py    media detection engine (video / audio / photo / carousel / album / playlist / mixed)
  gallery.py   photo engine: Instagram, TikTok photo mode, X, Facebook (+ gallery-dl), generic; downloads, ZIP
  ytdl.py      yt-dlp wrapper: options, retries, YouTube client/cookie fallbacks, friendly errors, caches
  jobs.py      job manager: queue, pause/resume/retry, ffprobe verification, quality guard, cleanup
  media.py     API response builders (qualities, audio presets, thumbnails, galleries)
  tools.py     uploads, ffprobe metadata, audio conversion jobs
  admin.py     admin auth + monitoring API          monitor.py  in-memory metrics & error log
  security.py  CSP/HSTS/framing headers, size limits, caching   pages.py  server-rendered pages, sitemap
templates/     base layout, home app shell, Media Tools, admin, content & legal pages
static/js/     core.js (shared), app.js (downloader), tools.js, admin.js, page.js, i18n*.js, zip.js, exif.js
static/css/    style.css (themes, accents, components)        static/fonts/  self-hosted Inter + Hind Siliguri
tests/         pytest suite (network-free)
```

## 🧪 Testing

```bash
pip install -r requirements-dev.txt
pytest -q          # 75 tests, no network needed
```

## 🛠️ Troubleshooting

* **YouTube "not a bot" / "refusing requests"** (`bot_check`, `yt_blocked`) — YouTube limits data-centre IPs.
  MediaGrab retries other player clients and, if cookies are configured, retries without them. Permanent fix:
  fresh cookies from a private window, or a residential `PROXY`. The admin error log shows per-client diagnostics.
* **4K not offered** — the source doesn't have it, or YouTube withheld it from the server for a moment (the UI
  says so). MediaGrab never upscales.
* **Facebook "login required"** — single photo pages are login-only; public posts and albums work. Add
  `facebook.txt` cookies for the rest.
* **FFmpeg not found** — install it or set `FFMPEG_LOCATION`. `/api/health` shows what the server detects.
* **Render build "missing from the repository"** — upload the whole project including its folders.

---

## 🇧🇩 বাংলায় দ্রুত গাইড

1. **লোকালি চালাতে:** Python 3.11+, FFmpeg ও Deno ইনস্টল করুন → `pip install -r requirements.txt` → `./run.sh` → `http://localhost:8000`।
2. **Docker দিয়ে:** `docker compose up -d --build` — ব্যস!
3. **Render-এ:** GitHub-এ পুরো প্রজেক্ট (সব ফোল্ডারসহ: `app`, `static`, `templates`, `scripts`) আপলোড করুন → Render → New → Blueprint। আগে থেকে Render সার্ভিস থাকলে শুধু একই GitHub repo-তে নতুন কোড দিন, Render নিজে থেকেই আবার deploy করবে। Environment-এ `ADMIN_TOKEN` (লম্বা গোপন টোকেন), `PUBLIC_BASE_URL`, `CONTACT_EMAIL` ও `FORCE_HTTPS=true` যোগ করুন।
4. **অ্যাডমিন ড্যাশবোর্ড:** `/admin` খুলে `ADMIN_TOKEN` দিয়ে লগইন করুন — সার্ভারের অবস্থা, ডাউনলোড পরিসংখ্যান ও এরর লগ দেখতে পাবেন।
5. **কুকি (YouTube/Facebook):** কখনো GitHub-এ কুকি ফাইল দেবেন না! Render → Environment → Secret Files-এ `youtube.txt` / `facebook.txt` যোগ করুন (`cookies/README.md` দেখুন)।
6. **কোনো সাইট হঠাৎ কাজ না করলে:** কনটেইনার রিস্টার্ট দিন (yt-dlp নিজে আপডেট হয়) অথবা `pip install -U "yt-dlp[default,curl-cffi]"`।

## ⚖️ Legal

MediaGrab is a tool for downloading content you own or have permission to use. It does not bypass DRM,
paywalls, private accounts or other access controls. Respect copyright and each platform's terms of service.

## 📄 License

MIT — see [LICENSE](LICENSE).
