"use client";

import { useEffect, useRef, useState } from "react";

type Item = { id: string; name: string; url: string; w: number; h: number; size: number };

const UHD_W = 3840;
const UHD_H = 2160;

const is4K = (w: number, h: number) => Math.max(w, h) >= UHD_W && Math.min(w, h) >= UHD_H;
const exact = (w: number, h: number) => (w === UHD_W && h === UHD_H) || (w === UHD_H && h === UHD_W);

function pickBest(items: Item[]): string | null {
  let best: string | null = null;
  let bs = Infinity;
  for (const it of items) {
    if (!is4K(it.w, it.h)) continue;
    const land = it.w >= it.h;
    const ratio = Math.abs(Math.max(it.w, it.h) / Math.min(it.w, it.h) - 16 / 9);
    const px = (it.w * it.h) / (UHD_W * UHD_H);
    const s = (exact(it.w, it.h) && land ? 0 : exact(it.w, it.h) ? 0.5 : 1) + (land ? 0 : 0.3) + ratio + (px - 1) * 0.5;
    if (s < bs) {
      bs = s;
      best = it.id;
    }
  }
  return best;
}

function label(w: number, h: number) {
  const l = Math.max(w, h);
  return l >= 7680 ? "8K" : l >= 3840 ? "4K" : l >= 2560 ? "QHD" : l >= 1920 ? "Full HD" : l >= 1280 ? "HD" : "SD";
}

function loadDims(file: File): Promise<Item | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      resolve({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, url, w: img.naturalWidth, h: img.naturalHeight, size: file.size });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export default function LocalWallpaperPicker() {
  const [items, setItems] = useState<Item[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    const list = urls.current;
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const loaded = (await Promise.all([...files].map(loadDims))).filter((x): x is Item => !!x);
    urls.current.push(...loaded.map((l) => l.url));
    setItems(loaded);
    const best = pickBest(loaded);
    setChosen(best);
    setAuto(true);
  }

  const best = pickBest(items);
  const sel = items.find((i) => i.id === chosen) ?? null;

  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400/10 to-violet-500/10 p-5">
      <h2 className="text-lg font-semibold">Select files — get the right 4K wallpaper</h2>
      <p className="mt-1 text-sm text-slate-400">
        Choose several image files from your device. We read their real resolution and automatically select the correct 4K (3840×2160) file — lower-resolution files are never picked.
      </p>
      <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold hover:bg-violet-400">
        📁 Select image files
        <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
      </label>

      {items.length > 0 && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_340px]">
          <ul className="space-y-2">
            {items.map((it) => {
              const k = is4K(it.w, it.h);
              return (
                <li
                  key={it.id}
                  className={`flex items-center gap-3 rounded-lg border p-2.5 text-sm ${
                    it.id === chosen ? "border-emerald-400/60 bg-emerald-400/10" : "border-white/10 bg-slate-900/50"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={it.url} alt={it.name} className="h-12 w-20 shrink-0 rounded object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{it.name}</div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      {it.w}×{it.h} · {(it.size / 1048576).toFixed(1)} MB
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${k ? "bg-cyan-400/20 text-cyan-200" : "bg-white/10 text-slate-300"}`}>{label(it.w, it.h)}</span>
                      {it.id === best && <span className="rounded bg-emerald-400/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">★ RIGHT 4K FILE</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setChosen(it.id);
                      setAuto(it.id === best);
                    }}
                    className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                  >
                    {it.id === chosen ? "Selected" : "Select"}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="space-y-3">
            {sel ? (
              <div className="overflow-hidden rounded-xl border border-white/10 bg-slate-900">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sel.url} alt={sel.name} className="aspect-video w-full object-cover" />
                <div className="space-y-2 p-3 text-sm">
                  <div className="font-semibold">{sel.name}</div>
                  <div className={is4K(sel.w, sel.h) ? "text-emerald-300" : "text-amber-300"}>
                    {is4K(sel.w, sel.h) ? `✓ ${sel.w}×${sel.h} — valid 4K wallpaper${auto ? " (auto-selected)" : ""}` : `✕ ${sel.w}×${sel.h} is below 4K`}
                  </div>
                  <a href={sel.url} download={sel.name} className="inline-block rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400">
                    ⬇ Save selected file
                  </a>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
                None of the selected files is 4K (3840×2160 or larger). Choose a higher-resolution file.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
