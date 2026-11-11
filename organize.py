#!/usr/bin/env python3
"""Rebuilds the folder structure when the repo was uploaded flat (all files in the root).
Runs during the Docker build. Safe to keep even when folders already exist."""
import os, shutil

MAP = {
    "__init__.py": "app/__init__.py",
    "admin.py": "app/admin.py",
    "config.py": "app/config.py",
    "detect.py": "app/detect.py",
    "extras.py": "app/extras.py",
    "gallery.py": "app/gallery.py",
    "jobs.py": "app/jobs.py",
    "main.py": "app/main.py",
    "media.py": "app/media.py",
    "monitor.py": "app/monitor.py",
    "pages.py": "app/pages.py",
    "ratelimit.py": "app/ratelimit.py",
    "security.py": "app/security.py",
    "tools.py": "app/tools.py",
    "utils.py": "app/utils.py",
    "ytdl.py": "app/ytdl.py",
    "make_og_image.py": "scripts/make_og_image.py",
    "start.sh": "scripts/start.sh",
    "style.css": "static/css/style.css",
    "hind-bengali-400.woff2": "static/fonts/hind-bengali-400.woff2",
    "hind-bengali-600.woff2": "static/fonts/hind-bengali-600.woff2",
    "inter-latin-400-800.woff2": "static/fonts/inter-latin-400-800.woff2",
    "favicon.svg": "static/icons/favicon.svg",
    "icon-192.png": "static/icons/icon-192.png",
    "icon-512.png": "static/icons/icon-512.png",
    "maskable-512.png": "static/icons/maskable-512.png",
    "og-image.png": "static/icons/og-image.png",
    "admin.js": "static/js/admin.js",
    "app.js": "static/js/app.js",
    "boot.js": "static/js/boot.js",
    "core.js": "static/js/core.js",
    "exif.js": "static/js/exif.js",
    "i18n-v2.js": "static/js/i18n-v2.js",
    "i18n.js": "static/js/i18n.js",
    "icons.js": "static/js/icons.js",
    "page.js": "static/js/page.js",
    "tools.js": "static/js/tools.js",
    "zip.js": "static/js/zip.js",
    "manifest.webmanifest": "static/manifest.webmanifest",
    "sw.js": "static/sw.js",
    "404.html": "templates/404.html",
    "_footer.html": "templates/_footer.html",
    "_macros.html": "templates/_macros.html",
    "_nav.html": "templates/_nav.html",
    "admin.html": "templates/admin.html",
    "base.html": "templates/base.html",
    "index.html": "templates/index.html",
    "offline.html": "templates/offline.html",
    "about.html": "templates/pages/about.html",
    "api-docs.html": "templates/pages/api-docs.html",
    "contact.html": "templates/pages/contact.html",
    "dmca.html": "templates/pages/dmca.html",
    "faq.html": "templates/pages/faq.html",
    "how-to-use.html": "templates/pages/how-to-use.html",
    "platforms.html": "templates/pages/platforms.html",
    "privacy.html": "templates/pages/privacy.html",
    "terms.html": "templates/pages/terms.html",
    "tools.html": "templates/tools.html",
}

moved = 0
for name, dest in MAP.items():
    if os.path.isfile(name) and not os.path.isfile(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(name, dest)
        moved += 1
print(f"[organize] moved {moved} file(s) into folders")
