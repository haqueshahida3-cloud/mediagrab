"""Server-rendered pages (Jinja2): home app shell, Media Tools, content/legal pages, admin shell, SEO files."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from .config import settings

router = APIRouter(include_in_schema=False)
env = Environment(
    loader=FileSystemLoader(str(settings.templates_dir)),
    autoescape=select_autoescape(["html", "xml"]),
    trim_blocks=True,
    lstrip_blocks=True,
)
STATIC = settings.static_dir


def ldjson(obj) -> Markup:
    """JSON for <script type="application/ld+json"> — escaped so it can never close the script tag."""
    text = json.dumps(obj, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return Markup(text)


def faq_jsonld(faqs) -> Markup:
    return ldjson({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]})


env.globals.update(ldjson=ldjson, faq_jsonld=faq_jsonld)
BUILD_DATE = datetime.now(timezone.utc).strftime("%Y-%m-%d")

# page key → (path, {lang: (title, description)}, sitemap priority)
PAGES: dict[str, dict] = {
    "home": {"path": "/", "prio": "1.0", "meta": {
        "en": ("MediaGrab — Download Videos, Photos & MP3 from YouTube, Facebook, Instagram, X & TikTok",
               "Free online downloader for YouTube, Facebook, Instagram, X (Twitter) and TikTok. Save videos in "
               "genuine HD, 4K and 8K, download photos, carousels and albums, or convert to MP3 — no signup."),
        "bn": ("MediaGrab — YouTube, Facebook, Instagram, X ও TikTok থেকে ভিডিও, ছবি ও MP3 ডাউনলোড",
               "ফ্রি অনলাইন ডাউনলোডার — আসল HD, 4K ও 8K ভিডিও, ছবি, ক্যারোসেল ও অ্যালবাম ডাউনলোড করুন বা MP3-তে "
               "রূপান্তর করুন। কোনো সাইন-আপ লাগে না।")}},
    "tools": {"path": "/tools", "prio": "0.9", "meta": {
        "en": ("Media Tools — Video to MP3, Image Converter, Metadata Viewer | MediaGrab",
               "Convert video to MP3, WAV or M4A, convert JPG, PNG and WebP images, grab video frames and inspect "
               "video, audio and image metadata. Images never leave your device."),
        "bn": ("মিডিয়া টুলস — ভিডিও থেকে MP3, ইমেজ কনভার্টার, মেটাডেটা | MediaGrab",
               "ভিডিও থেকে MP3/WAV/M4A, JPG-PNG-WebP ছবি রূপান্তর, ভিডিও থেকে ছবি এবং মেটাডেটা দেখুন।")}},
    "platforms": {"path": "/platforms", "prio": "0.8", "meta": {
        "en": ("Supported Platforms — YouTube, Facebook, Instagram, X, TikTok & 1000+ sites | MediaGrab",
               "What you can download from each platform: videos up to 8K, Shorts, Reels, photo posts, "
               "carousels, albums, TikTok photo mode, playlists and more."),
        "bn": ("সমর্থিত প্ল্যাটফর্ম | MediaGrab", "কোন প্ল্যাটফর্ম থেকে কী ডাউনলোড করা যায় — ভিডিও, শর্টস, রিলস, ছবি, "
               "ক্যারোসেল, অ্যালবাম ও আরও অনেক কিছু।")}},
    "how-to-use": {"path": "/how-to-use", "prio": "0.8", "meta": {
        "en": ("How to Use MediaGrab — Download Videos & Photos in 3 Steps",
               "Step-by-step guide: copy a link, paste it into MediaGrab and choose a genuine quality, MP3 or photos."),
        "bn": ("কীভাবে ব্যবহার করবেন | MediaGrab", "৩ ধাপে ভিডিও ও ছবি ডাউনলোড করার সহজ গাইড।")}},
    "faq": {"path": "/faq", "prio": "0.7", "meta": {
        "en": ("FAQ — MediaGrab Video & Photo Downloader", "Answers about quality, 4K/8K, photos, MP3, privacy, "
               "limits and errors."),
        "bn": ("সাধারণ প্রশ্ন (FAQ) | MediaGrab", "কোয়ালিটি, 4K/8K, ছবি, MP3, প্রাইভেসি ও সমস্যা সমাধান নিয়ে প্রশ্নোত্তর।")}},
    "about": {"path": "/about", "prio": "0.6", "meta": {
        "en": ("About MediaGrab", "Why MediaGrab exists, how it works and what we stand for."),
        "bn": ("MediaGrab সম্পর্কে", "MediaGrab কেন, কীভাবে কাজ করে এবং আমাদের নীতি।")}},
    "contact": {"path": "/contact", "prio": "0.5", "meta": {
        "en": ("Contact — MediaGrab", "Get in touch about support, feedback or copyright requests."),
        "bn": ("যোগাযোগ — MediaGrab", "সাপোর্ট, মতামত বা কপিরাইট অনুরোধের জন্য যোগাযোগ করুন।")}},
    "privacy": {"path": "/privacy", "prio": "0.4", "meta": {
        "en": ("Privacy Policy — MediaGrab", "What MediaGrab stores (almost nothing), for how long, and why."),
        "bn": ("প্রাইভেসি পলিসি — MediaGrab", "MediaGrab কী সংরক্ষণ করে (প্রায় কিছুই না), কতক্ষণ ও কেন।")}},
    "terms": {"path": "/terms", "prio": "0.4", "meta": {
        "en": ("Terms of Service — MediaGrab", "The rules for using MediaGrab."),
        "bn": ("ব্যবহারের শর্তাবলি — MediaGrab", "MediaGrab ব্যবহারের নিয়ম।")}},
    "dmca": {"path": "/dmca", "prio": "0.4", "meta": {
        "en": ("DMCA & Copyright Policy — MediaGrab", "How to report copyright concerns and how MediaGrab handles them."),
        "bn": ("DMCA ও কপিরাইট নীতি — MediaGrab", "কপিরাইট সংক্রান্ত অভিযোগ কীভাবে জানাবেন।")}},
    "api-docs": {"path": "/api-docs", "prio": "0.5", "meta": {
        "en": ("API Documentation — MediaGrab", "REST API for media detection, downloads, jobs, photos and tools."),
        "bn": ("API ডকুমেন্টেশন — MediaGrab", "মিডিয়া ডিটেকশন, ডাউনলোড, জব, ছবি ও টুলসের REST API।")}},
}

CHROME = {
    "en": {"nav_home": "Downloader", "nav_tools": "Media Tools", "nav_platforms": "Platforms",
           "nav_how": "How to use", "nav_faq": "FAQ", "nav_more": "More", "about": "About us", "contact": "Contact",
           "privacy": "Privacy Policy", "terms": "Terms of Service", "dmca": "DMCA / Copyright",
           "api": "API Documentation", "rights": "All rights reserved.", "product": "Product", "company": "Company",
           "legal": "Legal", "skip": "Skip to content", "menu": "Menu", "theme": "Theme", "lang": "বাংলা",
           "disclaimer": "MediaGrab is a tool for saving content you own or have permission to use. Respect "
                         "copyright and each platform's terms. Files are deleted from our server automatically.",
           "home_cta": "Open the downloader", "updated": "Last updated", "not_found": "Page not found",
           "not_found_text": "The page you're looking for doesn't exist or has moved.", "back_home": "Back to home"},
    "bn": {"nav_home": "ডাউনলোডার", "nav_tools": "মিডিয়া টুলস", "nav_platforms": "প্ল্যাটফর্ম",
           "nav_how": "ব্যবহারবিধি", "nav_faq": "প্রশ্নোত্তর", "nav_more": "আরও", "about": "আমাদের সম্পর্কে",
           "contact": "যোগাযোগ", "privacy": "প্রাইভেসি পলিসি", "terms": "ব্যবহারের শর্তাবলি",
           "dmca": "DMCA / কপিরাইট", "api": "API ডকুমেন্টেশন", "rights": "সর্বস্বত্ব সংরক্ষিত।",
           "product": "প্রোডাক্ট", "company": "প্রতিষ্ঠান", "legal": "আইনি", "skip": "মূল কনটেন্টে যান",
           "menu": "মেনু", "theme": "থিম", "lang": "English",
           "disclaimer": "MediaGrab শুধুমাত্র আপনার নিজের বা অনুমতিপ্রাপ্ত কনটেন্ট সংরক্ষণের জন্য। কপিরাইট ও "
                         "প্ল্যাটফর্মের নিয়ম মেনে চলুন। ফাইলগুলো আমাদের সার্ভার থেকে স্বয়ংক্রিয়ভাবে মুছে যায়।",
           "home_cta": "ডাউনলোডার খুলুন", "updated": "সর্বশেষ হালনাগাদ", "not_found": "পেজটি পাওয়া যায়নি",
           "not_found_text": "আপনি যে পেজটি খুঁজছেন সেটি নেই বা সরানো হয়েছে।", "back_home": "হোমে ফিরে যান"},
}


def base_url(request: Request) -> str:
    if settings.public_base_url:
        return settings.public_base_url
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip() if settings.trust_proxy else ""
    host = request.headers.get("x-forwarded-host") if settings.trust_proxy else None
    host = host or request.headers.get("host") or request.url.netloc
    return f"{proto or request.url.scheme}://{host}"


def lang_of(request: Request) -> str:
    q = request.query_params.get("lang")
    if q in ("en", "bn"):
        return q
    c = request.cookies.get("mg_lang")
    if c in ("en", "bn"):
        return c
    return "bn" if request.headers.get("accept-language", "").lower().startswith("bn") else "en"


OTHER_META = {
    "404": {"path": "/404", "meta": {"en": ("Page not found — MediaGrab", "This page doesn't exist."),
                                     "bn": ("পেজটি পাওয়া যায়নি — MediaGrab", "এই পেজটি নেই।")}},
    "offline": {"path": "/offline", "meta": {"en": ("Offline — MediaGrab", "You're offline."), "bn": ("অফলাইন — MediaGrab", "আপনি অফলাইনে আছেন।")}},
    "admin": {"path": "/admin", "meta": {"en": ("Admin dashboard — MediaGrab", "System monitoring."),
                                         "bn": ("অ্যাডমিন ড্যাশবোর্ড — MediaGrab", "সিস্টেম মনিটরিং।")}},
}


def render(request: Request, template: str, key: str, status: int = 200, **ctx) -> HTMLResponse:
    lang = lang_of(request)
    page = PAGES.get(key) or OTHER_META.get(key) or PAGES["home"]
    title, desc = page["meta"].get(lang, page["meta"]["en"])
    base = base_url(request)
    path = page["path"] if key in PAGES else request.url.path
    canonical = base + path + ("?lang=bn" if lang == "bn" else "")
    html = env.get_template(template).render(
        request=request, lang=lang, t=CHROME[lang], key=key, title=title, description=desc,
        base=base, path=path, canonical=canonical, alt_en=base + path, alt_bn=base + path + "?lang=bn",
        version=settings.version, app_name=settings.app_name, contact_email=settings.contact_email,
        admin_enabled=settings.admin_enabled, build_date=BUILD_DATE, year=time.gmtime().tm_year,
        settings=settings, json=json, **ctx,
    )
    resp = HTMLResponse(html, status_code=status, headers={"Cache-Control": "no-cache"})
    return resp


def _page(key: str, template: str | None = None):
    async def handler(request: Request):
        return render(request, template or f"pages/{key}.html", key)
    handler.__name__ = f"page_{key.replace('-', '_')}"
    return handler


@router.get("/")
async def home(request: Request):
    return render(request, "index.html", "home")


@router.get("/tools")
async def tools_page(request: Request):
    return render(request, "tools.html", "tools")


for _key in ("platforms", "how-to-use", "faq", "about", "contact", "privacy", "terms", "dmca", "api-docs"):
    router.add_api_route(PAGES[_key]["path"], _page(_key), methods=["GET"])


@router.get("/admin")
async def admin_page(request: Request):
    if not settings.admin_enabled:
        return not_found(request)
    resp = render(request, "admin.html", "admin")
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    return resp


def not_found(request: Request) -> HTMLResponse:
    return render(request, "404.html", "404", status=404)


@router.get("/sitemap.xml")
async def sitemap(request: Request):
    base = base_url(request)
    urls = []
    for p in PAGES.values():
        loc = base + p["path"]
        urls.append(
            f"<url><loc>{loc}</loc><lastmod>{BUILD_DATE}</lastmod><priority>{p['prio']}</priority>"
            f'<xhtml:link rel="alternate" hreflang="en" href="{loc}"/>'
            f'<xhtml:link rel="alternate" hreflang="bn" href="{loc}?lang=bn"/></url>'
        )
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
           'xmlns:xhtml="http://www.w3.org/1999/xhtml">' + "".join(urls) + "</urlset>")
    return Response(xml, media_type="application/xml", headers={"Cache-Control": "public, max-age=3600"})


@router.get("/robots.txt")
async def robots(request: Request):
    body = (f"User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\n"
            f"Sitemap: {base_url(request)}/sitemap.xml\n")
    return Response(body, media_type="text/plain", headers={"Cache-Control": "public, max-age=3600"})


@router.get("/sw.js")
async def service_worker():
    body = (STATIC / "sw.js").read_text().replace("__VERSION__", settings.version)
    return Response(body, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@router.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@router.get("/favicon.ico")
async def favicon():
    return FileResponse(STATIC / "icons" / "favicon.svg", media_type="image/svg+xml",
                        headers={"Cache-Control": "public, max-age=604800"})


@router.get("/offline")
async def offline(request: Request):
    return render(request, "offline.html", "offline")
