import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "./utils/cn";
import { GlassSidebar, NAV, useSidebarStore } from "./components/sidebar";
import { Icon, type IconName } from "./components/sidebar/icons";

const DEFAULT_ID = "home";
const idFromHash = () => {
  const id = decodeURIComponent(location.hash.replace(/^#/, ""));
  return NAV.index.has(id) ? id : DEFAULT_ID;
};

const FEATURES: { icon: IconName; title: string; tip: string; hue: string }[] = [
  { icon: "panel", title: "Collapsible & resizable", tip: "Press Ctrl+B, or drag the glowing edge. Double-click it to reset. Drag past the edge to snap shut.", hue: "#60a5fa" },
  { icon: "layers", title: "Multi-level navigation", tip: "Groups nest three levels deep with smooth height animation and a sliding glass indicator.", hue: "#818cf8" },
  { icon: "pin", title: "Pinned shortcuts", tip: "Drag any page from the tree into “Pinned”, then drag tiles to reorder them.", hue: "#34d399" },
  { icon: "star", title: "Favorites & recent", tip: "Star pages on hover. Downloads and page visits are logged to Recent activity.", hue: "#fbbf24" },
  { icon: "menu", title: "Context-aware menus", tip: "Right-click a page, a group, a pinned tile, a recent entry — or empty sidebar space — for different menus.", hue: "#f472b6" },
  { icon: "palette", title: "Custom icon themes", tip: "Outline, Tinted, Neon or Gradient — switch from the palette button at the bottom.", hue: "#a78bfa" },
];

function Toggle({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: IconName; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium ring-1 backdrop-blur transition-all duration-200 active:scale-95",
        on ? "bg-white/15 text-white ring-white/25" : "bg-white/[0.05] text-slate-300 ring-white/10 hover:bg-white/10 hover:text-white",
      )}
    >
      <Icon name={icon} size={15} fill={on ? "currentColor" : "none"} className={on ? (icon === "star" ? "text-amber-300" : "text-sky-300") : ""} />
      {label}
    </button>
  );
}

export default function App() {
  const store = useSidebarStore();
  const [activeId, setActiveId] = useState(idFromHash);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const go = useCallback((id: string) => {
    setActiveId(id);
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const visit = (id: string) => {
    store.expandPath(id);
    if (id !== activeId) store.logVisit(id);
    go(id);
  };

  useEffect(() => {
    const onHash = () => {
      const id = idFromHash();
      setActiveId(id);
      store.expandPath(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [store.expandPath]);

  // reveal the starting page in the tree
  useEffect(() => {
    store.expandPath(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const item = NAV.index.get(activeId)!;
  const crumbs = [...item.path.map((p) => NAV.index.get(p)!), item];
  const pinned = store.pinned.includes(activeId);
  const fav = store.favorites.includes(activeId);

  const siblings = useMemo(() => {
    const parent = item.parentId ? NAV.index.get(item.parentId) : undefined;
    const list = parent ? parent.children! : NAV.tree.filter((n) => n.children);
    return list.filter((n) => n.id !== activeId).slice(0, 6);
  }, [item, activeId]);

  const runAction = (label: string) => {
    if (busy) return;
    setBusy(true);
    window.setTimeout(() => {
      store.logAction(label, activeId);
      setBusy(false);
      setUrl("");
    }, 900);
  };

  const hostOf = (v: string) => {
    try {
      return new URL(v.startsWith("http") ? v : `https://${v}`).hostname.replace(/^www\./, "");
    } catch {
      return v.slice(0, 24);
    }
  };

  const kind = item.kind ?? "info";

  return (
    <div className="relative min-h-screen overflow-x-hidden text-slate-200">
      {/* ambient backdrop so the glass has something to blur */}
      <div className="pointer-events-none fixed inset-0 -z-0 overflow-hidden">
        <div className="absolute -left-40 top-[-10%] h-[620px] w-[620px] animate-float rounded-full bg-blue-600/25 blur-[120px]" />
        <div className="absolute right-[-10%] top-[20%] h-[560px] w-[560px] animate-float rounded-full bg-violet-600/25 blur-[130px]" style={{ animationDelay: "-3s" }} />
        <div className="absolute bottom-[-20%] left-[30%] h-[520px] w-[520px] animate-float rounded-full bg-fuchsia-600/15 blur-[130px]" style={{ animationDelay: "-5s" }} />
        <div
          className="absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage: "radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px)",
            backgroundSize: "26px 26px",
            maskImage: "radial-gradient(ellipse at 60% 30%, #000 20%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 60% 30%, #000 20%, transparent 75%)",
          }}
        />
      </div>

      <GlassSidebar store={store} activeId={activeId} onNavigate={go} />

      <main
        className="relative z-10 px-4 pb-24 pt-5 transition-[padding] duration-[380ms] ease-[cubic-bezier(.32,.72,0,1)] md:pr-8"
        style={{ paddingLeft: store.isMobile ? undefined : store.panelWidth + 12 + 32 }}
      >
        <div className="mx-auto max-w-4xl">
          {/* top bar */}
          <div className="mb-8 flex items-center gap-3">
            {store.isMobile && (
              <button
                onClick={() => store.setMobileOpen(true)}
                aria-label="Open menu"
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.07] ring-1 ring-white/10 backdrop-blur transition-all active:scale-90"
              >
                <Icon name="menu" size={18} />
              </button>
            )}
            <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-slate-400" aria-label="Breadcrumb">
              <button onClick={() => visit("home")} className="transition-colors hover:text-white">
                MediaGrab
              </button>
              {crumbs
                .filter((c) => c.id !== "home")
                .map((c, i, arr) => (
                  <span key={c.id} className="flex min-w-0 items-center gap-1.5">
                    <Icon name="chevron" size={12} className="shrink-0 text-slate-600" />
                    <span className={cn("truncate", i === arr.length - 1 && "font-medium text-white")}>{c.label}</span>
                  </span>
                ))}
            </nav>
            <div className="hidden items-center gap-1.5 text-[12px] text-slate-500 lg:flex">
              <kbd className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-slate-300 ring-1 ring-white/10">Ctrl</kbd>
              <kbd className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-slate-300 ring-1 ring-white/10">B</kbd>
              toggle sidebar
            </div>
          </div>

          {/* hero */}
          <section key={activeId} className="animate-rise">
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{
                  background: `linear-gradient(135deg, ${item.hue}33, ${item.hue}10)`,
                  boxShadow: `inset 0 0 0 1px ${item.hue}55, 0 10px 40px -10px ${item.hue}99`,
                  color: item.hue,
                }}
              >
                <Icon name={item.icon ?? "sparkles"} size={26} />
              </span>
              {item.badge && (
                <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider" style={{ background: `${item.hue}22`, color: item.hue }}>
                  {item.badge}
                </span>
              )}
            </div>
            <h1 className="bg-gradient-to-br from-white via-white to-slate-400 bg-clip-text text-4xl font-semibold tracking-tight text-transparent md:text-5xl">
              {kind === "home" ? "Download anything. Keep the quality." : item.label}
            </h1>
            <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-slate-400">
              {item.description ?? "Pick an item from the sidebar to get started."}
            </p>
            {!item.children && (
              <div className="mt-5 flex flex-wrap gap-2">
                <Toggle on={fav} icon="star" label={fav ? "Favorited" : "Add to favorites"} onClick={() => store.toggleFavorite(activeId)} />
                <Toggle on={pinned} icon="pin" label={pinned ? "Pinned" : "Pin shortcut"} onClick={() => store.togglePin(activeId)} />
              </div>
            )}
          </section>

          {/* action card */}
          <section key={`${activeId}-card`} className="animate-rise mt-8" style={{ animationDelay: "80ms" }}>
            <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl md:p-6">
              <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl" />
              {(kind === "download" || kind === "home") && (
                <>
                  <label className="mb-2 block text-[13px] font-medium text-slate-300">Paste a video or photo link</label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="relative flex-1">
                      <Icon name="link" size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=…"
                        className="h-12 w-full rounded-2xl bg-black/30 pl-11 pr-4 text-[14px] text-white placeholder-slate-500 outline-none ring-1 ring-white/10 transition focus:ring-2 focus:ring-sky-400/60"
                      />
                    </div>
                    <button
                      disabled={!url.trim() || busy}
                      onClick={() => runAction(`Fetched ${hostOf(url)}`)}
                      className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 to-violet-500 px-6 text-[14px] font-semibold text-white shadow-[0_10px_30px_-8px_rgba(99,102,241,.9)] transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Icon name={busy ? "reset" : "download"} size={17} className={busy ? "animate-spin" : ""} />
                      {busy ? "Fetching…" : "Fetch"}
                    </button>
                  </div>
                  <p className="mt-3 text-[12px] text-slate-500">
                    Try it — every fetch is added to <span className="text-slate-300">Recent activity</span> in the sidebar.
                  </p>
                </>
              )}
              {kind === "tool" && (
                <button
                  onClick={() => runAction(`Used ${item.label}`)}
                  className="flex w-full flex-col items-center gap-3 rounded-2xl border border-dashed border-white/15 bg-black/20 px-6 py-12 text-center transition-all hover:border-sky-300/50 hover:bg-sky-400/5 active:scale-[0.99]"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                    <Icon name={busy ? "reset" : "plus"} size={22} className={busy ? "animate-spin" : ""} />
                  </span>
                  <span className="text-[15px] font-medium text-white">{busy ? "Processing…" : "Drop a file or click to browse"}</span>
                  <span className="text-[12px] text-slate-500">Runs privately in your browser</span>
                </button>
              )}
              {kind === "ai" && (
                <>
                  <label className="mb-2 block text-[13px] font-medium text-slate-300">Video link or text</label>
                  <textarea
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    rows={3}
                    placeholder="Paste a link and let AI do the work…"
                    className="w-full resize-none rounded-2xl bg-black/30 p-4 text-[14px] text-white placeholder-slate-500 outline-none ring-1 ring-white/10 transition focus:ring-2 focus:ring-violet-400/60"
                  />
                  <button
                    disabled={!url.trim() || busy}
                    onClick={() => runAction(`${item.label}: ${hostOf(url)}`)}
                    className="mt-3 flex h-11 items-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 text-[14px] font-semibold text-white shadow-[0_10px_30px_-8px_rgba(168,85,247,.9)] transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon name={busy ? "reset" : "sparkles"} size={16} className={busy ? "animate-spin" : ""} />
                    {busy ? "Thinking…" : `Run ${item.label}`}
                  </button>
                </>
              )}
              {(kind === "library" || kind === "info") && (
                <div>
                  <div className="mb-3 text-[13px] font-medium text-slate-300">
                    {kind === "library" ? "Your recent activity" : "About this page"}
                  </div>
                  {kind === "library" && store.recent.length > 0 ? (
                    <ul className="divide-y divide-white/5">
                      {store.recent.slice(0, 5).map((r) => (
                        <li key={r.key} className="flex items-center gap-3 py-2.5 text-[14px]">
                          <Icon name={r.kind === "action" ? "zap" : "clock"} size={15} className="text-slate-500" />
                          <span className="flex-1 truncate">{r.label}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[14px] leading-relaxed text-slate-400">
                      This is placeholder content for “{item.label}”. Replace it with your own page — the sidebar already tracks it in Recent activity and highlights it with the glass indicator.
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* related */}
          {siblings.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {item.parentId ? "More in this section" : "Explore"}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {siblings.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => visit(firstLeaf(s.id))}
                    className="animate-rise group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3.5 text-left backdrop-blur transition-all duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.07] active:scale-[0.98]"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110" style={{ background: `${s.hue}22`, color: s.hue }}>
                      <Icon name={s.icon ?? "sparkles"} size={19} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-white">{s.label}</span>
                      <span className="block truncate text-[12px] text-slate-500">{s.children ? `${s.children.length} items` : s.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* feature tour */}
          <section className="mt-12">
            <h2 className="mb-1 text-xl font-semibold text-white">Try the sidebar</h2>
            <p className="mb-4 text-[14px] text-slate-400">Everything below is live — go poke at it.</p>
            <a
              href="./mediagrab-glass-sidebar.zip"
              download
              className="mb-4 inline-flex items-center gap-2 rounded-xl bg-white/[0.07] px-4 py-2.5 text-[13px] font-medium text-white ring-1 ring-white/15 backdrop-blur transition-all hover:bg-white/15 active:scale-95"
            >
              <Icon name="download" size={15} className="text-sky-300" />
              Download source (.zip)
            </a>
            <div className="grid gap-3 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 backdrop-blur transition-colors duration-300 hover:bg-white/[0.06]">
                  <div className="mb-2 flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `${f.hue}22`, color: f.hue }}>
                      <Icon name={f.icon} size={16} />
                    </span>
                    <h3 className="text-[14px] font-semibold text-white">{f.title}</h3>
                  </div>
                  <p className="text-[13px] leading-relaxed text-slate-400">{f.tip}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function firstLeaf(id: string): string {
  const n = NAV.index.get(id)!;
  return n.children ? firstLeaf(n.children[0].id) : n.id;
}
