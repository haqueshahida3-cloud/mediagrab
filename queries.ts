import { db } from "@/db";
import {
  collectionItems,
  collections,
  creators,
  media,
  mediaRelations,
  researchNotes,
  type Creator,
  type Media,
} from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";

export type MediaWithCreator = Media & { creator: Creator | null };

export async function getAllMedia(): Promise<MediaWithCreator[]> {
  const rows = await db
    .select({ m: media, c: creators })
    .from(media)
    .leftJoin(creators, eq(media.creatorId, creators.id))
    .orderBy(desc(media.createdAt));
  return rows.map((r) => ({ ...r.m, creator: r.c }));
}

export async function getMedia(id: number): Promise<MediaWithCreator | null> {
  const rows = await db
    .select({ m: media, c: creators })
    .from(media)
    .leftJoin(creators, eq(media.creatorId, creators.id))
    .where(eq(media.id, id));
  return rows[0] ? { ...rows[0].m, creator: rows[0].c } : null;
}

export async function getRelations() {
  return db.select().from(mediaRelations).orderBy(desc(mediaRelations.score));
}

export async function getCreatorsWithCounts() {
  const [cs, ms] = await Promise.all([
    db.select().from(creators).orderBy(creators.name),
    db.select({ id: media.id, creatorId: media.creatorId }).from(media),
  ]);
  return cs.map((c) => ({ ...c, count: ms.filter((m) => m.creatorId === c.id).length }));
}

export async function getCreator(id: number) {
  const [c] = await db.select().from(creators).where(eq(creators.id, id));
  if (!c) return null;
  const items = await db.select().from(media).where(eq(media.creatorId, id)).orderBy(desc(media.publishedAt));
  const ids = items.map((i) => i.id);
  const notes = await db
    .select()
    .from(researchNotes)
    .where(eq(researchNotes.creatorId, id))
    .orderBy(desc(researchNotes.createdAt));
  const mediaNotes = ids.length
    ? await db.select().from(researchNotes).where(inArray(researchNotes.mediaId, ids)).orderBy(desc(researchNotes.createdAt))
    : [];
  return { creator: c, items, notes, mediaNotes };
}

export async function getCollectionsWithItems() {
  const [cols, links] = await Promise.all([
    db.select().from(collections).orderBy(desc(collections.createdAt)),
    db.select().from(collectionItems),
  ]);
  return { cols, links };
}
