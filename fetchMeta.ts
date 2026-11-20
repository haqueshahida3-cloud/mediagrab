import dns from "node:dns/promises";
import net from "node:net";
import type { MediaFile } from "@/db/schema";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type Platform = "youtube" | "facebook" | "instagram" | "x" | "tiktok" | "web";

export function detectPlatform(url: string): Platform {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "web";
  }
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return "facebook";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return "x";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  return "web";
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

/** Throws if the URL is not a public http(s) URL (basic SSRF guard). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) links are supported");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private address blocked");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Private address blocked");
  } else {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("Private address blocked");
  }
  return u;
}

export async function safeFetch(url: string, init: RequestInit = {}, timeout = 9000): Promise<Response> {
  let current = url;
  for (let i = 0; i < 4; i++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location") as string, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/* ---------- image dimension probing ---------- */

function parseDims(b: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = dv.getUint16(o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) };
      }
      o += 2 + len;
    }
    return null;
  }
  // WebP
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8X") {
      return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (tag === "VP8 ") {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (tag === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export async function probeImage(url: string): Promise<{ width: number; height: number } | null> {
  try {
    const res = await safeFetch(url, { headers: { range: "bytes=0-131071", accept: "image/*,*/*" } }, 10000);
    if (!res.ok || !res.body) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.startsWith("image/") && !type.includes("octet-stream")) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 131072) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
      const buf = new Uint8Array(total);
      let p = 0;
      for (const c of chunks) {
        buf.set(c, p);
        p += c.length;
      }
      const d = parseDims(buf);
      if (d && d.width > 0 && d.height > 0) {
        await reader.cancel().catch(() => {});
        return d;
      }
    }
    await reader.cancel().catch(() => {});
    return null;
  } catch {
    return null;
  }
}

/* ---------- metadata ---------- */

export type FetchedMeta = {
  platform: Platform;
  kind: "video" | "image" | "audio" | "post";
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  publishedAt: Date | null;
  files: MediaFile[];
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function metaContent(html: string, key: string): string | null {
  const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${key}["']`, "i");
  const m = html.match(re1) ?? html.match(re2);
  return m ? decodeEntities(m[1]).trim() || null : null;
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of arr) if (p && typeof p === "object") out.push(p as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{6,})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await safeFetch(url, { headers: { accept: "application/json" } }, 7000);
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchMeta(url: string): Promise<FetchedMeta> {
  const platform = detectPlatform(url);
  const meta: FetchedMeta = {
    platform,
    kind: platform === "web" ? "post" : "video",
    title: "",
    description: null,
    thumbnailUrl: null,
    creatorName: null,
    creatorUrl: null,
    publishedAt: null,
    files: [],
  };

  // Direct image link
  try {
    const head = await safeFetch(url, { method: "GET", headers: { range: "bytes=0-1023" } }, 8000);
    const type = head.headers.get("content-type") ?? "";
    await head.body?.cancel().catch(() => {});
    if (type.startsWith("image/")) {
      const dims = await probeImage(url);
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "image");
      meta.kind = "image";
      meta.title = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ") || "Image";
      meta.thumbnailUrl = url;
      meta.files = [{ url, kind: "image", width: dims?.width ?? null, height: dims?.height ?? null, label: "Original" }];
      return meta;
    }
  } catch {
    /* fall through to HTML parsing */
  }

  // oEmbed providers
  let oembed: Record<string, unknown> | null = null;
  if (platform === "youtube") oembed = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  else if (platform === "tiktok") oembed = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  else if (platform === "x") oembed = await getJson(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url)}`);
  if (oembed) {
    if (typeof oembed.title === "string") meta.title = oembed.title;
    if (typeof oembed.author_name === "string") meta.creatorName = oembed.author_name;
    if (typeof oembed.author_url === "string") meta.creatorUrl = oembed.author_url;
    if (typeof oembed.thumbnail_url === "string") meta.thumbnailUrl = oembed.thumbnail_url;
    if (platform === "x" && typeof oembed.html === "string") {
      const p = oembed.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (p) {
        const text = decodeEntities(p[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).trim();
        meta.title = text.slice(0, 120) || meta.title;
        meta.description = text;
      }
      meta.kind = "post";
    }
  }

  // HTML page (open graph / json-ld)
  try {
    const res = await safeFetch(url, { headers: { accept: "text/html,application/xhtml+xml" } }, 9000);
    if (res.ok) {
      const html = (await res.text()).slice(0, 600000);
      const og = (k: string) => metaContent(html, k);
      const ld = jsonLd(html);
      const ldVideo = ld.find((x) => typeof x["@type"] === "string" && /Video|Article|Posting|ImageObject/.test(x["@type"] as string));
      if (!meta.title) {
        meta.title = og("og:title") ?? og("twitter:title") ?? decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
      }
      meta.description = meta.description ?? og("og:description") ?? og("description") ?? (ldVideo?.description as string | undefined) ?? null;
      const image = og("og:image") ?? og("twitter:image");
      if (image) {
        const abs = new URL(image, url).toString();
        meta.thumbnailUrl = meta.thumbnailUrl ?? abs;
        if (!meta.files.some((f) => f.url === abs)) meta.files.push({ url: abs, kind: "image", width: null, height: null, label: "Page image" });
      }
      const w = Number(og("og:image:width"));
      const h = Number(og("og:image:height"));
      if (image && w && h) {
        meta.files[0] = { ...meta.files[0], width: w, height: h };
      }
      meta.publishedAt =
        parseDate(og("article:published_time")) ??
        parseDate(og("datePublished")) ??
        parseDate(og("uploadDate")) ??
        parseDate(og("og:video:release_date")) ??
        parseDate(ldVideo?.datePublished as string | undefined) ??
        parseDate(ldVideo?.uploadDate as string | undefined);
      if (!meta.creatorName) {
        const author = ldVideo?.author as { name?: string; url?: string } | string | undefined;
        meta.creatorName =
          (typeof author === "string" ? author : author?.name) ?? og("author") ?? og("article:author") ?? og("og:site_name") ?? null;
        if (typeof author === "object" && author?.url) meta.creatorUrl = author.url;
      }
      const ogType = og("og:type") ?? "";
      if (/video/.test(ogType)) meta.kind = "video";
      else if (/music|audio/.test(ogType)) meta.kind = "audio";
    }
  } catch {
    /* page might block bots — oEmbed data still usable */
  }

  // YouTube: add thumbnails ladder as wallpaper candidates
  if (platform === "youtube") {
    const id = youtubeId(url);
    if (id) {
      meta.thumbnailUrl = meta.thumbnailUrl ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      meta.files.unshift({ url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, kind: "image", width: null, height: null, label: "Max-res thumbnail" });
    }
  }

  // Probe dimensions for any image files without known size
  await Promise.all(
    meta.files.map(async (f, i) => {
      if (f.width && f.height) return;
      const d = await probeImage(f.url);
      if (d) meta.files[i] = { ...f, width: d.width, height: d.height };
    }),
  );
  // Drop broken YouTube max-res placeholder (unknown size → image not available)
  meta.files = meta.files.filter((f) => f.width && f.height);

  if (!meta.title) {
    const u = new URL(url);
    meta.title = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? u.hostname).replace(/[-_]+/g, " ") || u.hostname;
  }
  meta.title = meta.title.slice(0, 300);
  if (meta.description) meta.description = meta.description.slice(0, 2000);
  return meta;
}
