# Changelog

## 2.0.0 — 2026-11-11

### Fixed (root causes found on the live site)
- **YouTube "Failed to extract any player response" / missing 4K.** Every player client failed with the configured
  cookies, and the fallback logic only reacted to "not a bot" messages — so no other client and no cookie-less
  attempt was ever tried, and the raw yt-dlp message was shown to users. Now: player-response, IP-block, 429/403 and
  "format not available" errors retry the fallback clients, then retry **without cookies**; when YouTube withholds
  formats (PO-token/SABR warnings) one extra attempt is made and the result with the highest genuine resolution wins.
  Friendly `yt_blocked` message; per-client diagnostics go to the admin error log; stale cookies are flagged.
- **Photo posts failed** ("No downloadable video was found"): yt-dlp only returns the video parts of Instagram posts,
  doesn't support TikTok `/photo/` URLs at all, and has no Facebook/X photo support. New photo engine (below).
- **Silent quality downgrade risk:** if the source can't deliver the requested resolution at download time, the job
  now fails *before* downloading with a clear `quality_unavailable` message instead of producing a lower quality.
- **Incomplete/broken files could be reported as finished:** every output is now verified with ffprobe (video and
  audio tracks present, duration complete, real resolution recorded).
- Disk-space check, automatic retry on network errors, FFmpeg/post-processing errors humanised, partial files kept for
  pause/resume and removed on cancel/failure, uploads cleaned up automatically.

### Added
- **Media detection engine** (`app/detect.py`): video, audio, photo, carousel, album, playlist, mixed.
- **Photo engine** (`app/gallery.py`): Instagram photos/carousels (incl. mixed), TikTok photo mode (images + sound),
  X photos in original quality (+ mixed posts), Facebook public post & album photos (gallery-dl when cookies exist),
  generic og:image fallback; original bytes, meaningful file names, ZIP for multiple items, resized previews.
- **Download manager:** pause / resume / retry / cancel endpoints, speed, ETA, size, verified output details,
  bulk actions, parallel-download setting, recent downloads + history.
- **Media Tools** page: audio extractor (link or upload), in-browser image converter (JPG/PNG/WebP + ZIP), thumbnail
  & frame grabber, image downloader, metadata viewer (formats table, EXIF, ffprobe analysis).
- **UI/UX:** redesigned app shell with themes (Light/Dark/AMOLED/Gray/System), accent colours, backgrounds (incl. own
  image), reduced motion, clipboard detection (with permission), keyboard shortcuts, favourite platforms, mobile menu,
  self-hosted fonts, PWA v2 (offline shell, shortcuts, update prompt).
- **Security:** CSP without inline scripts, HSTS, frame protection, COOP, request-size limits, optional HTTPS
  redirect, SSRF checks for media CDNs, gzip for text responses, safer caching for ES modules.
- **SEO:** server-rendered About, Platforms, How to use, FAQ, Contact, Privacy, Terms, DMCA and API docs pages in
  English & Bangla; canonical/hreflang, Open Graph image, JSON-LD, sitemap.xml, robots.txt.
- **Admin dashboard** (`/admin`, `ADMIN_TOKEN`): health, resources, success rates, queue, platforms, rate limits,
  cookies, error log with diagnostics.
- 22 new tests (75 total).

### Changed files
**Added:** `app/admin.py`, `app/detect.py`, `app/gallery.py`, `app/monitor.py`, `app/pages.py`, `app/security.py`,
`app/tools.py`, `templates/` (base, nav, footer, macros, index, tools, admin, 404, offline, `pages/` ×9),
`static/js/{core,boot,page,tools,admin,zip,exif,i18n-v2}.js`, `static/fonts/` (3 × woff2), `static/icons/og-image.png`,
`scripts/make_og_image.py`, `tests/{test_gallery,test_v2_core,test_v2_web}.py`, `docs/screenshots/{gallery,video-8k,tools,admin}.png`,
`CHANGELOG.md`.

**Modified:** `app/{config,jobs,main,media,ratelimit,utils,ytdl}.py`, `static/js/{app,icons}.js`, `static/css/style.css`,
`static/sw.js`, `static/manifest.webmanifest`, `requirements.txt` (+ jinja2, pillow, gallery-dl), `Dockerfile`,
`render.yaml`, `docker-compose.yml`, `.env.example`, `run.sh`, `cookies/README.md`, `README.md`,
`.github/workflows/ci.yml`, `docs/screenshots/{home,downloads,mobile-bn}.png`.

**Removed:** `static/index.html` (replaced by `templates/index.html`), `docs/screenshots/result.png`.

### New environment variables
`ADMIN_TOKEN`, `PUBLIC_BASE_URL`, `CONTACT_EMAIL`, `MAX_GALLERY_ITEMS`, `MAX_UPLOAD_MB`, `MIN_FREE_DISK_MB`,
`AUTO_RETRIES`, `RATE_LIMIT_TOOLS`, `SECRET_FILES_DIR`, `FORCE_HTTPS`, `ALLOW_FRAMING`, `MAX_JSON_BODY_KB`
(see README → Configuration).

## 1.0.0
Initial release: YouTube, Facebook, Instagram, X and TikTok video/audio downloads, playlists, batch, trim,
SponsorBlock, subtitles, PWA, English & Bangla.
