import { addFile, autoPick4K, selectFile } from "@/app/actions";
import type { Media } from "@/db/schema";
import { is4K, pickBest4K, resolutionLabel } from "@/lib/analyze";
import { btn, btnGhost, input, Thumb } from "@/components/ui";

export default function WallpaperFiles({ m, compact = false }: { m: Media; compact?: boolean }) {
  const files = m.files;
  const best = pickBest4K(files);
  const selected = m.selectedFile != null && files[m.selectedFile] ? m.selectedFile : null;
  const current = selected != null ? files[selected] : null;
  const safeName = m.title.slice(0, 40);

  return (
    <div className="space-y-4">
      {current && (
        <div className="overflow-hidden rounded-xl border border-emerald-400/40 bg-emerald-400/5">
          <Thumb src={current.url} alt={m.title} className={`w-full ${compact ? "aspect-video" : "aspect-video"}`} />
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div>
              <div className="font-semibold text-emerald-300">
                ✓ Selected: {resolutionLabel(current)}
              </div>
              <div className="text-xs text-slate-400">
                {is4K(current) ? "This is a true 4K file." : "Not 4K — pick the recommended file for a 4K wallpaper."}
              </div>
            </div>
            <a href={`/api/download?url=${encodeURIComponent(current.url)}&name=${encodeURIComponent(safeName)}`} className={btn}>
              ⬇ Download
            </a>
          </div>
        </div>
      )}

      {files.length === 0 ? (
        <p className="text-sm text-slate-400">No image files saved for this media. Add an image URL below to check its resolution.</p>
      ) : (
        <ul className="space-y-2">
          {files.map((f, i) => {
            const k = is4K(f);
            return (
              <li
                key={f.url}
                className={`flex flex-wrap items-center gap-3 rounded-lg border p-2.5 text-sm ${
                  i === selected ? "border-emerald-400/50 bg-emerald-400/10" : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <Thumb src={f.url} alt={f.label} className="h-12 w-20 shrink-0 rounded" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{resolutionLabel(f)}</span>
                    {k && <span className="rounded bg-cyan-400/20 px-1.5 py-0.5 text-[10px] font-bold text-cyan-200">4K</span>}
                    {i === best && <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">★ RIGHT 4K FILE</span>}
                    {i === selected && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-200">Selected</span>}
                  </div>
                  <div className="truncate text-xs text-slate-500">{f.label}</div>
                </div>
                {i !== selected && (
                  <form action={selectFile}>
                    <input type="hidden" name="id" value={m.id} />
                    <input type="hidden" name="index" value={i} />
                    <button className={btnGhost}>Select</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <form action={autoPick4K}>
          <input type="hidden" name="id" value={m.id} />
          <button className={btnGhost} disabled={best < 0}>
            ✦ Auto-select the right 4K file
          </button>
        </form>
        {best < 0 && files.length > 0 && <span className="text-xs text-amber-300">No 4K file available in this media.</span>}
      </div>

      {!compact && (
        <form action={addFile} className="flex flex-wrap gap-2">
          <input type="hidden" name="id" value={m.id} />
          <input name="url" required placeholder="Add another image URL (e.g. a 4K version)…" className={`${input} flex-1`} />
          <button className={btnGhost}>Add & check size</button>
        </form>
      )}
    </div>
  );
}
