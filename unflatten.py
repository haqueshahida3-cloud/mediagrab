"""Puts files back into their folders when the project was uploaded flat (e.g. from a phone)."""
import os, shutil, sys

MANIFEST = {
 "monitor.py": "app/monitor.py",
 "main.py": "app/main.py",
 "pages.py": "app/pages.py",
 "jobs.py": "app/jobs.py",
 "config.py": "app/config.py",
 "__init__.py": "app/__init__.py",
 "gallery.py": "app/gallery.py",
 "ratelimit.py": "app/ratelimit.py",
 "admin.py": "app/admin.py",
 "media.py": "app/media.py",
 "ytdl.py": "app/ytdl.py",
 "security.py": "app/security.py",
 "tools.py": "app/tools.py",
 "extras.py": "app/extras.py",
 "detect.py": "app/detect.py",
 "utils.py": "app/utils.py",
 "sw.js": "static/sw.js",
 "manifest.webmanifest": "static/manifest.webmanifest",
 "maskable-512.png": "static/icons/maskable-512.png",
 "og-image.png": "static/icons/og-image.png",
 "favicon.svg": "static/icons/favicon.svg",
 "icon-192.png": "static/icons/icon-192.png",
 "icon-512.png": "static/icons/icon-512.png",
 "hind-bengali-400.woff2": "static/fonts/hind-bengali-400.woff2",
 "inter-latin-400-800.woff2": "static/fonts/inter-latin-400-800.woff2",
 "hind-bengali-600.woff2": "static/fonts/hind-bengali-600.woff2",
 "style.css": "static/css/style.css",
 "i18n.js": "static/js/i18n.js",
 "zip.js": "static/js/zip.js",
 "core.js": "static/js/core.js",
 "page.js": "static/js/page.js",
 "app.js": "static/js/app.js",
 "tools.js": "static/js/tools.js",
 "boot.js": "static/js/boot.js",
 "icons.js": "static/js/icons.js",
 "i18n-v2.js": "static/js/i18n-v2.js",
 "admin.js": "static/js/admin.js",
 "exif.js": "static/js/exif.js",
 "start.sh": "scripts/start.sh",
 "make_og_image.py": "scripts/make_og_image.py",
 "admin.html": "templates/admin.html",
 "offline.html": "templates/offline.html",
 "404.html": "templates/404.html",
 "index.html": "templates/index.html",
 "tools.html": "templates/tools.html",
 "base.html": "templates/base.html",
 "_nav.html": "templates/_nav.html",
 "_macros.html": "templates/_macros.html",
 "_footer.html": "templates/_footer.html",
 "faq.html": "templates/pages/faq.html",
 "about.html": "templates/pages/about.html",
 "contact.html": "templates/pages/contact.html",
 "platforms.html": "templates/pages/platforms.html",
 "dmca.html": "templates/pages/dmca.html",
 "how-to-use.html": "templates/pages/how-to-use.html",
 "privacy.html": "templates/pages/privacy.html",
 "terms.html": "templates/pages/terms.html",
 "api-docs.html": "templates/pages/api-docs.html",
 "keepalive.py": "app/keepalive.py",
 "telegram_bot.py": "app/telegram_bot.py"
}

moved = 0
for name, dest in MANIFEST.items():
    if os.path.isfile(dest):
        continue
    if os.path.isfile(name):
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        shutil.move(name, dest)
        moved += 1
print(f"[unflatten] moved {moved} files into folders")

required = ["app/main.py", "templates/base.html", "templates/index.html",
            "static/js/app.js", "static/js/core.js", "static/css/style.css", "scripts/start.sh"]
missing = [f for f in required if not os.path.isfile(f)]
if missing:
    print("ERROR - missing from the repository: " + " ".join(missing))
    sys.exit(1)
