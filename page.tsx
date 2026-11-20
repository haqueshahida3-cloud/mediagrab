import Link from "next/link";
import LocalWallpaperPicker from "@/components/LocalWallpaperPicker";
import WallpaperFiles from "@/components/WallpaperFiles";
import { Card, Empty, PageHeader } from "@/components/ui";
import { pickBest4K } from "@/lib/analyze";
import { getAllMedia } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function WallpapersPage({ searchParams }: { searchParams: Promise<{ only4k?: string }> }) {
  const sp = await searchParams;
  const only = sp.only4k === "1";
  const all = (await getAllMedia()).filter((m) => m.files.some((f) => f.kind === "image"));
  const items = only ? all.filter((m) => pickBest4K(m.files) >= 0) : all;

  return (
    <div className="space-y-8">
      <PageHeader title="4K Wallpaper Selector" subtitle="Select files and MediaGrab picks the one right 4K file for you — exact 3840×2160 first, never a lower resolution." />

      <LocalWallpaperPicker />

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">From your library</h2>
          <div className="flex gap-2 text-sm">
            <Link href="/wallpapers" className={`rounded-lg px-3 py-1.5 ${!only ? "bg-violet-500" : "bg-white/5 hover:bg-white/10"}`}>
              All ({all.length})
            </Link>
            <Link href="/wallpapers?only4k=1" className={`rounded-lg px-3 py-1.5 ${only ? "bg-violet-500" : "bg-white/5 hover:bg-white/10"}`}>
              Only with 4K
            </Link>
          </div>
        </div>
        {items.length === 0 ? (
          <Empty>No saved media with image files{only ? " in 4K" : ""}. Save an image link or load demo data on the Library page.</Empty>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {items.map((m) => (
              <Card key={m.id} className="p-4">
                <Link href={`/media/${m.id}`} className="mb-3 block font-semibold hover:text-violet-300">
                  {m.title}
                </Link>
                <WallpaperFiles m={m} compact />
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
