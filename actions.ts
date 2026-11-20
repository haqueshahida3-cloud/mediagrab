"use server";

import { db } from "@/db";
import {
  collectionItems,
  collections,
  creators,
  media,
  mediaRelations,
  researchNotes,
  type MediaFile,
} from "@/db/schema";
import { computeRelations, extractTags, pickBest4K } from "@/lib/analyze";
import { assertPublicUrl, fetchMeta, probeImage } from "@/lib/fetchMeta";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type AddState = { ok?: string; error?: string; id?: number };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const num = (fd: FormData, k: string) => {
  const n = Number(str(fd, k));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function refresh() {
  revalidatePath("/", "layout");
}

async function upsertCreator(name: string, platform: string, profileUrl?: string | null) {
  const [row] = await db
    .insert(creators)
    .values({ name, platform, profileUrl: profileUrl ?? null, handle: handleFromUrl(profileUrl) })
    .onConflictDoUpdate({
      target: [creators.name, creators.platform],
      set: { profileUrl: sql`coalesce(${creators.profileUrl}, excluded.profile_url)` },
    })
    .returning();
  return row;
}

function handleFromUrl(u?: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u).pathname.split("/").filter(Boolean);
    const h = p.find((s) => s.startsWith("@")) ?? p[p.length - 1];
    return h ? (h.startsWith("@") ? h : `@${h}`) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Analysis: tags → relationships → smart topic collections           */
/* ------------------------------------------------------------------ */

export async function analyze() {
  const all = await db.select().from(media);

  for (const m of all) {
    if (m.tags.length === 0) {
      const tags = extractTags(m.title, m.description);
      if (tags.length) {
        await db.update(media).set({ tags }).where(eq(media.id, m.id));
        m.tags = tags;
      }
    }
  }

  await db.delete(mediaRelations).where(eq(mediaRelations.auto, true));
  const rels = computeRelations(all.map((m) => ({ id: m.id, creatorId: m.creatorId, tags: m.tags, publishedAt: m.publishedAt })));
  for (let i = 0; i < rels.length; i += 200) {
    await db
      .insert(mediaRelations)
      .values(rels.slice(i, i + 200).map((r) => ({ ...r, auto: true })))
      .onConflictDoNothing();
  }

  // smart collections for tags shared by 2+ items
  const byTag = new Map<string, number[]>();
  for (const m of all) for (const t of m.tags) byTag.set(t, [...(byTag.get(t) ?? []), m.id]);
  const topics = [...byTag.entries()].filter(([, ids]) => ids.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  const existing = await db.select().from(collections);
  for (const [tag, ids] of topics) {
    let col = existing.find((c) => c.auto && c.topic === tag);
    if (!col) {
      [col] = await db
        .insert(collections)
        .values({ name: tag.charAt(0).toUpperCase() + tag.slice(1), topic: tag, auto: true, description: `Auto-collected media about “${tag}”.` })
        .returning();
    }
    await db
      .insert(collectionItems)
      .values(ids.map((mediaId) => ({ collectionId: (col as { id: number }).id, mediaId })))
      .onConflictDoNothing();
  }
}

export async function runAnalysis() {
  await analyze();
  refresh();
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

export async function addMedia(_prev: AddState, fd: FormData): Promise<AddState> {
  const url = str(fd, "url");
  if (!url) return { error: "Paste a link first." };
  try {
    await assertPublicUrl(url);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid link." };
  }
  const [dup] = await db.select({ id: media.id }).from(media).where(eq(media.url, url));
  if (dup) return { error: "This link is already in your library.", id: dup.id };

  let meta;
  try {
    meta = await fetchMeta(url);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not fetch this link." };
  }

  const title = str(fd, "title") || meta.title;
  const creatorName = str(fd, "creator") || meta.creatorName;
  const manualDate = str(fd, "date");
  const publishedAt = manualDate ? new Date(manualDate) : meta.publishedAt;
  const manualTags = str(fd, "tags")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  let creatorId: number | null = null;
  if (creatorName) {
    const c = await upsertCreator(creatorName, meta.platform, meta.creatorUrl);
    creatorId = c.id;
  }

  const files = meta.files;
  const [row] = await db
    .insert(media)
    .values({
      url,
      platform: meta.platform,
      kind: meta.kind,
      title,
      description: meta.description,
      thumbnailUrl: meta.thumbnailUrl ?? files[0]?.url ?? null,
      creatorId,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      tags: manualTags.length ? manualTags : extractTags(title, meta.description),
      files,
      selectedFile: files.length ? (pickBest4K(files) >= 0 ? pickBest4K(files) : null) : null,
    })
    .returning();
  await analyze();
  refresh();
  return { ok: `Added “${row.title}”`, id: row.id };
}

export async function deleteMedia(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  await db.delete(media).where(eq(media.id, id));
  await analyze();
  refresh();
  redirect("/");
}

export async function updateTags(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  const tags = [
    ...new Set(
      str(fd, "tags")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  await db.update(media).set({ tags }).where(eq(media.id, id));
  await analyze();
  refresh();
}

/* ---------- files / 4K wallpaper ---------- */

export async function addFile(fd: FormData) {
  const id = num(fd, "id");
  const url = str(fd, "url");
  if (!id || !url) return;
  try {
    await assertPublicUrl(url);
  } catch {
    return;
  }
  const [m] = await db.select().from(media).where(eq(media.id, id));
  if (!m || m.files.some((f) => f.url === url)) return;
  const dims = await probeImage(url);
  const file: MediaFile = { url, kind: "image", width: dims?.width ?? null, height: dims?.height ?? null, label: str(fd, "label") || "Added file" };
  const files = [...m.files, file];
  const best = pickBest4K(files);
  await db
    .update(media)
    .set({ files, selectedFile: best >= 0 ? best : m.selectedFile })
    .where(eq(media.id, id));
  refresh();
}

export async function selectFile(fd: FormData) {
  const id = num(fd, "id");
  const index = Number(str(fd, "index"));
  if (!id || !Number.isInteger(index)) return;
  await db.update(media).set({ selectedFile: index }).where(eq(media.id, id));
  refresh();
}

export async function autoPick4K(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  const [m] = await db.select().from(media).where(eq(media.id, id));
  if (!m) return;
  const best = pickBest4K(m.files);
  await db.update(media).set({ selectedFile: best >= 0 ? best : null }).where(eq(media.id, id));
  refresh();
}

/* ---------- relationships ---------- */

export async function connectMedia(fd: FormData) {
  const a = num(fd, "a");
  const b = num(fd, "b");
  if (!a || !b || a === b) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const label = str(fd, "label") || "manually connected";
  await db
    .insert(mediaRelations)
    .values({ aId: lo, bId: hi, type: "manual", score: 1, label, auto: false })
    .onConflictDoUpdate({
      target: [mediaRelations.aId, mediaRelations.bId],
      set: { type: "manual", score: 1, label, auto: false },
    });
  refresh();
}

export async function removeRelation(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  await db.delete(mediaRelations).where(eq(mediaRelations.id, id));
  refresh();
}

/* ---------- collections ---------- */

export async function createCollection(fd: FormData) {
  const name = str(fd, "name");
  if (!name) return;
  await db.insert(collections).values({ name, topic: str(fd, "topic").toLowerCase() || null, description: str(fd, "description") || null });
  refresh();
}

export async function deleteCollection(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  await db.delete(collections).where(eq(collections.id, id));
  refresh();
}

export async function addToCollection(fd: FormData) {
  const collectionId = num(fd, "collectionId");
  const mediaId = num(fd, "mediaId");
  if (!collectionId || !mediaId) return;
  await db.insert(collectionItems).values({ collectionId, mediaId }).onConflictDoNothing();
  refresh();
}

export async function removeFromCollection(fd: FormData) {
  const collectionId = num(fd, "collectionId");
  const mediaId = num(fd, "mediaId");
  if (!collectionId || !mediaId) return;
  await db.delete(collectionItems).where(and(eq(collectionItems.collectionId, collectionId), eq(collectionItems.mediaId, mediaId)));
  refresh();
}

/* ---------- creator knowledge profile ---------- */

export async function updateCreator(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  await db
    .update(creators)
    .set({
      bio: str(fd, "bio") || null,
      notes: str(fd, "notes") || null,
      handle: str(fd, "handle") || null,
      profileUrl: str(fd, "profileUrl") || null,
    })
    .where(eq(creators.id, id));
  refresh();
}

export async function addNote(fd: FormData) {
  const content = str(fd, "content");
  if (!content) return;
  const kind = ["note", "link", "quote"].includes(str(fd, "kind")) ? str(fd, "kind") : "note";
  await db.insert(researchNotes).values({ content, kind, creatorId: num(fd, "creatorId"), mediaId: num(fd, "mediaId") });
  refresh();
}

export async function deleteNote(fd: FormData) {
  const id = num(fd, "id");
  if (!id) return;
  await db.delete(researchNotes).where(eq(researchNotes.id, id));
  refresh();
}

/* ---------- demo data ---------- */

export async function loadDemo() {
  const pic = (id: number, w: number, h: number) => `https://picsum.photos/id/${id}/${w}/${h}`;
  const files = (id: number): MediaFile[] => [
    { url: pic(id, 3840, 2160), kind: "image", width: 3840, height: 2160, label: "4K UHD" },
    { url: pic(id, 2560, 1440), kind: "image", width: 2560, height: 1440, label: "QHD" },
    { url: pic(id, 1920, 1080), kind: "image", width: 1920, height: 1080, label: "Full HD" },
  ];
  const creatorDefs = [
    { name: "Aurora Lens", platform: "youtube", bio: "Landscape & aurora photographer documenting northern skies.", handle: "@auroralens" },
    { name: "Urban Frames", platform: "instagram", bio: "City street photography and architecture reels.", handle: "@urbanframes" },
    { name: "Code Canvas", platform: "tiktok", bio: "Creative coding and generative art explained in 60 seconds.", handle: "@codecanvas" },
  ];
  const cr: Record<string, number> = {};
  for (const c of creatorDefs) {
    const [row] = await db
      .insert(creators)
      .values({ ...c, profileUrl: `https://example.com/${c.handle}` })
      .onConflictDoUpdate({ target: [creators.name, creators.platform], set: { bio: c.bio } })
      .returning();
    cr[c.name] = row.id;
  }
  const d = (s: string) => new Date(s);
  const items = [
    ["Aurora over the mountains timelapse", "Aurora Lens", "2023-02-11", ["aurora", "timelapse", "mountains", "night"], 10],
    ["Chasing the northern lights in Iceland", "Aurora Lens", "2023-09-03", ["aurora", "iceland", "night", "travel"], 11],
    ["Mountain sunrise photography guide", "Aurora Lens", "2024-04-20", ["mountains", "sunrise", "photography", "guide"], 13],
    ["Night sky photography settings", "Aurora Lens", "2024-11-15", ["night", "photography", "guide", "stars"], 15],
    ["Neon city streets at night", "Urban Frames", "2023-10-08", ["city", "night", "neon", "photography"], 16],
    ["Glass skyscrapers: architecture walk", "Urban Frames", "2024-03-02", ["city", "architecture", "glass", "travel"], 17],
    ["Tokyo street photography diary", "Urban Frames", "2024-11-22", ["city", "photography", "travel", "street"], 18],
    ["Generative art in 60 seconds", "Code Canvas", "2024-01-14", ["generative", "art", "code", "creative"], 19],
    ["Shaders that look like aurora", "Code Canvas", "2024-05-09", ["generative", "aurora", "code", "shaders"], 20],
    ["Procedural city generator", "Code Canvas", "2025-01-30", ["generative", "city", "code", "procedural"], 21],
  ] as const;
  for (const [title, creator, date, tags, pid] of items) {
    const url = `https://demo.mediagrab.local/watch/${pid}`;
    await db
      .insert(media)
      .values({
        url,
        platform: creatorDefs.find((c) => c.name === creator)!.platform,
        kind: "video",
        title,
        description: `${title} — demo entry.`,
        thumbnailUrl: pic(pid, 640, 360),
        creatorId: cr[creator],
        publishedAt: d(date),
        tags: [...tags],
        files: files(pid),
        selectedFile: 0,
      })
      .onConflictDoNothing();
  }
  await analyze();
  const [first] = await db.select({ id: creators.id }).from(creators).where(eq(creators.name, "Aurora Lens"));
  if (first) {
    const have = await db.select({ id: researchNotes.id }).from(researchNotes).where(eq(researchNotes.creatorId, first.id));
    if (!have.length) {
      await db.insert(researchNotes).values([
        { creatorId: first.id, kind: "note", content: "Posts every ~6 months. Best content is long-form guides with raw 4K stills in the description." },
        { creatorId: first.id, kind: "quote", content: "“The sky is the only studio that never closes.”" },
      ]);
    }
  }
  refresh();
}

export async function clearAll() {
  await db.delete(mediaRelations);
  await db.delete(collections);
  await db.delete(researchNotes);
  await db.delete(media);
  await db.delete(creators);
  refresh();
}
