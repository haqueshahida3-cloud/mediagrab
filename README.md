# Cookies (optional)

MediaGrab downloads **public** content without any login. Some content needs a logged-in
session — private/age-restricted YouTube videos, some Instagram reels & stories, Facebook
videos in groups, etc. — and YouTube may show a *"Sign in to confirm you're not a bot"* check
to servers in data centres. A cookies file fixes all of these.

## How to add cookies

1. Use a **secondary / throw-away account** (never your main account).
2. Log in to the site in your browser.
3. Export cookies in **Netscape format** with an extension such as
   *"Get cookies.txt LOCALLY"* (Chrome/Edge) or *"cookies.txt"* (Firefox).
4. Save the file in this folder using the platform name:

| File | Used for |
|------|----------|
| `youtube.txt` | YouTube |
| `instagram.txt` | Instagram |
| `facebook.txt` | Facebook |
| `twitter.txt` (or `x.txt`) | X / Twitter |
| `tiktok.txt` | TikTok |

5. Restart the server. `GET /api/health` shows which platforms have cookies loaded.

> 🔒 Cookie files are secrets — they are ignored by git (`.gitignore`) and Docker (`.dockerignore`).
> MediaGrab copies them to a private temp file per job so concurrent downloads never corrupt them.
> YouTube rotates cookies quickly; for YouTube export them from a private/incognito window and
> close that window right after exporting.
