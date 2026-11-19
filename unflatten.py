"""Puts files back into their folders when the project was uploaded flat (e.g. from a phone).

Also tolerates phone-style duplicate names ("name (1).js", "name(2).css": the newest copy wins) and any stray
.js / .css file in the repo root (moved to static/js or static/css).
"""
import os
import re
import shutil
import sys

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
 "dashboard-addon.css": "static/css/dashboard-addon.css",
 "mediagrab-ux-upgrade.css": "static/css/mediagrab-ux-upgrade.css",
 "dashboard-addon.js": "static/js/dashboard-addon.js",
 "mediagrab-ux-upgrade.js": "static/js/mediagrab-ux-upgrade.js"
}

OPTIONAL_ASSETS = ["static/js/mediagrab-ux-upgrade.js", "static/js/dashboard-addon.js",
                   "static/css/mediagrab-ux-upgrade.css", "static/css/dashboard-addon.css"]
NUMBERED = re.compile(r"^(?P<stem>.+?)\s*\((?P<n>\d+)\)(?P<ext>\.[^.]+)$")

# 1) "name (1).js" -> "name.js" (highest number wins over an older copy)
copies = {}
for f in os.listdir("."):
    m = NUMBERED.match(f)
    if m and os.path.isfile(f):
        copies.setdefault(m["stem"] + m["ext"], []).append((int(m["n"]), f))
for base, items in copies.items():
    if base in MANIFEST or base.endswith((".js", ".css")):
        items.sort()
        os.replace(items[-1][1], base)
        for _, extra in items[:-1]:
            os.remove(extra)
        print(f"[unflatten] renamed {items[-1][1]!r} -> {base!r}")

# 2) known files into their folders
moved = 0
for name, dest in MANIFEST.items():
    if os.path.isfile(dest):
        continue
    if os.path.isfile(name):
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        shutil.move(name, dest)
        moved += 1

# 3) unknown .js / .css files in the root are front-end assets
for f in sorted(os.listdir(".")):
    if os.path.isfile(f) and f.endswith((".js", ".css")):
        dest = ("static/js/" if f.endswith(".js") else "static/css/") + f
        if not os.path.isfile(dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.move(f, dest)
            moved += 1
            print(f"[unflatten] extra asset -> {dest}")
print(f"[unflatten] moved {moved} files into folders")

for a in OPTIONAL_ASSETS:
    print(f"[unflatten] {'ok     ' if os.path.isfile(a) else 'MISSING'} {a}")

required = ["app/main.py", "templates/base.html", "templates/index.html",
            "static/js/app.js", "static/js/core.js", "static/css/style.css", "scripts/start.sh"]
missing = [f for f in required if not os.path.isfile(f)]
if missing:
    print("ERROR - missing from the repository: " + " ".join(missing))
    sys.exit(1)
