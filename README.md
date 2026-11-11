# Cookies (optional)

MediaGrab downloads **public** content without any login. A logged-in session (cookies) helps when:

- YouTube shows *"Sign in to confirm you're not a bot"* / *"refusing requests"* to servers in data centres,
- a Facebook **photo page** is only shown to logged-in users (public posts and albums work without cookies),
- Instagram stories / highlights, age-restricted videos, or rate-limited platforms.

MediaGrab never uses cookies to bypass privacy: content you couldn't see while logged in to that account stays unavailable.

> ⚠️ **Never commit cookie files to GitHub.** A cookies file is a logged-in session — anyone who can read
> your repository could use the account. If you ever uploaded one, make the repo private (or delete the file
> and its history) and **log out of that account in the browser** to invalidate the session.

## 1. Export the cookies

1. Use a **secondary / throw-away account** (never your main account).
2. Log in to the site in your browser. For YouTube use a **private/incognito window** (YouTube rotates
   cookies of normal windows quickly) and close the window right after exporting.
3. Export cookies in **Netscape format** with an extension such as *"Get cookies.txt LOCALLY"*
   (Chrome/Edge) or *"cookies.txt"* (Firefox).

| File name | Used for |
|---|---|
| `youtube.txt` | YouTube |
| `instagram.txt` | Instagram |
| `facebook.txt` | Facebook (also enables full Facebook photo/album extraction via gallery-dl) |
| `twitter.txt` (or `x.txt`) | X / Twitter |
| `tiktok.txt` | TikTok |

## 2. Give them to the server

**Render (recommended):** Dashboard → your service → **Environment** → **Secret Files** → *Add Secret File*,
name it e.g. `youtube.txt` and paste the contents. Secret files are mounted at `/etc/secrets/` and MediaGrab
picks them up automatically (`SECRET_FILES_DIR`). Redeploy once after adding them.

**Docker / VPS:** put the files in this `cookies/` folder (it's ignored by git and Docker builds) and mount it:
`./cookies:/app/cookies:ro` (see `docker-compose.yml`), or point `COOKIES_DIR` to another folder.

## 3. Check

`GET /api/health` → `"cookies": {"youtube": true, …}`. The admin dashboard (`/admin`) shows the same and warns
when a platform reports that the cookies **are no longer valid** — export fresh ones then.

MediaGrab copies the file to a private temp file per job (yt-dlp rewrites cookie files) and, if YouTube
rejects the logged-in session, automatically retries **without** cookies.
