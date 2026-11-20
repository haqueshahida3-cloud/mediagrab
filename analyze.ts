import type { MediaFile } from "@/db/schema";

const STOP = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with you your official video videos new full hd 4k 8k live watch youtube tiktok instagram facebook twitter reel reels shorts post photo photos www http https com org net html amp via ft feat part episode ep`.split(
    /\s+/,
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w),
  );
}

/** Extract the top keywords from a title (weighted x3) and description. */
export function extractTags(title: string, description?: string | null, max = 5): string[] {
  const score = new Map<string, number>();
  for (const w of tokenize(title)) score.set(w, (score.get(w) ?? 0) + 3);
  for (const w of tokenize((description ?? "").slice(0, 1500))) score.set(w, (score.get(w) ?? 0) + 1);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([w]) => w);
}

export type SimInput = {
  id: number;
  creatorId: number | null;
  tags: string[];
  publishedAt: Date | null;
};

export type PairRelation = {
  aId: number;
  bId: number;
  type: "same_creator" | "shared_topic" | "same_period";
  score: number;
  label: string;
};

/** Compute auto relationships between every pair of media. */
export function computeRelations(items: SimInput[], threshold = 0.2): PairRelation[] {
  const out: PairRelation[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const A = new Set(a.tags);
      const B = new Set(b.tags);
      const shared = [...A].filter((t) => B.has(t));
      const union = new Set([...A, ...B]).size || 1;
      const jaccard = shared.length / union;
      const sameCreator = a.creatorId != null && a.creatorId === b.creatorId;
      let days = Infinity;
      if (a.publishedAt && b.publishedAt) {
        days = Math.abs(a.publishedAt.getTime() - b.publishedAt.getTime()) / 86400000;
      }
      const close = days <= 30;
      let score = jaccard * 0.7 + (sameCreator ? 0.35 : 0) + (close && shared.length ? 0.1 : 0);
      if (shared.length === 0 && !sameCreator) score = 0;
      score = Math.min(1, score);
      if (score < threshold && !(sameCreator && score >= 0.1)) continue;
      const reasons: string[] = [];
      if (sameCreator) reasons.push("same creator");
      if (shared.length) reasons.push(`topics: ${shared.slice(0, 3).join(", ")}`);
      if (close && shared.length) reasons.push("published close together");
      const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
      out.push({
        aId: lo.id,
        bId: hi.id,
        type: sameCreator && shared.length === 0 ? "same_creator" : shared.length ? "shared_topic" : "same_period",
        score: Math.round(score * 100) / 100,
        label: reasons.join(" · "),
      });
    }
  }
  return out;
}

/* ---------- 4K wallpaper helpers ---------- */

export const UHD_W = 3840;
export const UHD_H = 2160;

export type Dim = { width: number | null; height: number | null };

export function is4K(f: Dim): boolean {
  if (!f.width || !f.height) return false;
  const long = Math.max(f.width, f.height);
  const short = Math.min(f.width, f.height);
  return long >= UHD_W && short >= UHD_H;
}

export function isExact4K(f: Dim): boolean {
  if (!f.width || !f.height) return false;
  return (f.width === UHD_W && f.height === UHD_H) || (f.width === UHD_H && f.height === UHD_W);
}

export function resolutionLabel(f: Dim): string {
  if (!f.width || !f.height) return "unknown size";
  const long = Math.max(f.width, f.height);
  const tag = long >= 7680 ? "8K" : long >= 3840 ? "4K" : long >= 2560 ? "2K/QHD" : long >= 1920 ? "Full HD" : long >= 1280 ? "HD" : "SD";
  return `${f.width}×${f.height} · ${tag}`;
}

/**
 * Pick the single right 4K wallpaper:
 *  1. exact 3840×2160 landscape
 *  2. otherwise the smallest 4K-or-larger landscape file (closest to 16:9)
 *  3. otherwise nothing (-1) — never a lower-res file.
 */
export function pickBest4K<T extends Dim>(files: T[]): number {
  let best = -1;
  let bestScore = Infinity;
  files.forEach((f, i) => {
    if (!is4K(f)) return;
    const w = f.width as number;
    const h = f.height as number;
    const landscape = w >= h;
    const exact = isExact4K(f);
    const ratioDiff = Math.abs(Math.max(w, h) / Math.min(w, h) - 16 / 9);
    const pixels = (w * h) / (UHD_W * UHD_H);
    const score = (exact && landscape ? 0 : exact ? 0.5 : 1) + (landscape ? 0 : 0.3) + ratioDiff + (pixels - 1) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

export function filesOf(m: { files: MediaFile[] }): MediaFile[] {
  return m.files.filter((f) => f.kind === "image");
}
