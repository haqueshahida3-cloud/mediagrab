import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type MediaFile = {
  url: string;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  label: string;
};

export const creators = pgTable(
  "creators",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    platform: text("platform").notNull().default("web"),
    handle: text("handle"),
    profileUrl: text("profile_url"),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("creators_name_platform_idx").on(t.name, t.platform)],
);

export const media = pgTable("media", {
  id: serial("id").primaryKey(),
  url: text("url").notNull().unique(),
  platform: text("platform").notNull().default("web"),
  kind: text("kind").notNull().default("video"),
  title: text("title").notNull(),
  description: text("description"),
  thumbnailUrl: text("thumbnail_url"),
  creatorId: integer("creator_id").references(() => creators.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  files: jsonb("files").$type<MediaFile[]>().notNull().default([]),
  selectedFile: integer("selected_file"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const collections = pgTable("collections", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  topic: text("topic"),
  auto: boolean("auto").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: integer("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.mediaId] })],
);

export const mediaRelations = pgTable(
  "media_relations",
  {
    id: serial("id").primaryKey(),
    aId: integer("a_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    bId: integer("b_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    score: real("score").notNull().default(0),
    label: text("label"),
    auto: boolean("auto").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("media_relations_pair_idx").on(t.aId, t.bId)],
);

export const researchNotes = pgTable("research_notes", {
  id: serial("id").primaryKey(),
  creatorId: integer("creator_id").references(() => creators.id, { onDelete: "cascade" }),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("note"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Creator = typeof creators.$inferSelect;
export type Media = typeof media.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type MediaRelation = typeof mediaRelations.$inferSelect;
export type ResearchNote = typeof researchNotes.$inferSelect;
