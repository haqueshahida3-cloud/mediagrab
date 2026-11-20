import Link from "next/link";
import { clearAll, deleteMedia, loadDemo, runAnalysis } from "@/app/actions";
import AddLinkForm from "@/components/AddLinkForm";
import { btn, btnGhost, Card, fmtDate, PlatformBadge, Tag, Thumb } from "@/components/ui";
import { getAllMedia, getRelations } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [items, rels] = await Promise.all([getAllMedia(), getRelations()]);
  const creatorCount = new Set(items.map((i) => i.creatorId).filter(Boolean)).size;
  const topicCount = new Set(items.flatMap((i) => i.tags)).size;

  const features = [
    { href: "/map", t: "Visual Media Map", d: "Interactive graph of media, creators and topics." },
    { href: "/creators", t: "Creator Knowledge", d: "Creator metadata plus your saved research." },
    { href: "/collections", t: "Topic Collections", d: "Auto & manual collections by topic." },
    { href: "/graph", t: "Relationship Graph", d: "See and connect related media." },
    { href: "/timeline", t: "Content Timeline", d: "Everything ordered by publish date." },
    { href: "/wallpapers", t: "4K Wallpapers", d: "Pick the one right 4K file, automatically." },
  ];

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Save media. <span className="bg-gradient-to-r from-violet-400 to-cyan-300 bg-clip-text text-transparent">Understand it.</span>
        </h1>
        <p className="mt-2 max-w-2xl text-slate-400">
          Paste any link — MediaGrab pulls its metadata, finds topics, connects related media and builds your personal knowledge map.
        </p>
        <div className="mt-5">
          <AddLinkForm />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Media", items.length],
          ["Creators", creatorCount],
          ["Topics", topicCount],
          ["Connections", rels.length],
        ].map(([l, v]) => (
          <Card key={l} className="p-4">
            <div className="text-2xl font-bold">{v}</div>
            <div className="text-xs uppercase tracking-wide text-slate-400">{l}</div>
          </Card>
        ))}
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <Link key={f.href} href={f.href} className="group rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-violet-400/50 hover:bg-white/[0.06]">
            <div className="font-semibold group-hover:text-violet-300">{f.t} →</div>
            <div className="mt-1 text-sm text-slate-400">{f.d}</div>
          </Link>
        ))}
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Library</h2>
          <div className="flex flex-wrap gap-2">
            <form action={runAnalysis}>
              <button className={btnGhost}>↻ Re-run AI analysis</button>
            </form>
            <form action={loadDemo}>
              <button className={btnGhost}>Load demo data</button>
            </form>
            {items.length > 0 && (
              <form action={clearAll}>
                <button className={btnGhost}>Clear all</button>
              </form>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-slate-300">Nothing saved yet. Paste a link above, or explore every feature with sample data.</p>
            <form action={loadDemo} className="mt-4">
              <button className={btn}>Load demo data</button>
            </form>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((m) => (
              <Card key={m.id} className="group overflow-hidden">
                <Link href={`/media/${m.id}`} className="block">
                  <Thumb src={m.thumbnailUrl} alt={m.title} className="aspect-video w-full" />
                </Link>
                <div className="space-y-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <PlatformBadge platform={m.platform} />
                    <span className="text-[11px] text-slate-500">{fmtDate(m.publishedAt)}</span>
                  </div>
                  <Link href={`/media/${m.id}`} className="line-clamp-2 text-sm font-semibold leading-snug hover:text-violet-300">
                    {m.title}
                  </Link>
                  {m.creator && (
                    <Link href={`/creators/${m.creator.id}`} className="block text-xs text-slate-400 hover:text-slate-200">
                      by {m.creator.name}
                    </Link>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {m.tags.slice(0, 4).map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </div>
                  <form action={deleteMedia}>
                    <input type="hidden" name="id" value={m.id} />
                    <button className="text-[11px] text-slate-500 hover:text-rose-300">Remove</button>
                  </form>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
