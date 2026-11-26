import { useEffect, useState } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./icons";
import { ItemIcon } from "./ItemIcon";
import { NAV } from "./navData";
import { useSidebar } from "./context";
import { trackSpotlight } from "./NavTree";

function timeAgo(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Favorites + Recent Activity, switchable with an animated segmented control. */
export function QuickLists() {
  const { store, collapsed, theme, activeId, navigate, openItemMenu, openRecentMenu } = useSidebar();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const favs = store.favorites.map((id) => NAV.index.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const recent = store.recent.slice(0, 6);

  if (collapsed) {
    return (
      <div className="space-y-0.5 border-t border-white/[0.07] pt-3">
        {(
          [
            ["favorites", "star", "Favorites", favs.length],
            ["recent", "clock", "Recent activity", recent.length],
          ] as const
        ).map(([tab, icon, label, count]) => (
          <button
            key={tab}
            title={label}
            onClick={() => {
              store.setTab(tab);
              store.setCollapsed(false);
            }}
            className="group/row relative flex h-11 w-full items-center justify-center rounded-[14px] text-slate-400 transition-all duration-200 hover:bg-white/[0.06] hover:text-white active:scale-90"
          >
            <Icon name={icon} size={18} className="transition-transform duration-300 group-hover/row:scale-110" />
            {count > 0 && (
              <span className="absolute right-2 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-white/10 px-1 text-[9px] font-semibold text-slate-200">
                {count}
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  const tab = store.tab;

  return (
    <section aria-label="Favorites and recent activity" className="border-t border-white/[0.07] pt-3">
      <div className="relative mb-2 grid grid-cols-2 rounded-xl bg-black/25 p-0.5 text-[12px] font-medium ring-1 ring-white/[0.06]">
        <span
          className="absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[10px] bg-white/10 shadow-[0_0_14px_-2px_rgba(129,140,248,.45)] ring-1 ring-white/15 transition-transform duration-300 ease-[cubic-bezier(.32,.72,0,1)]"
          style={{ transform: tab === "favorites" ? "translateX(0)" : "translateX(100%)" }}
        />
        {(
          [
            ["favorites", "star", "Favorites", favs.length],
            ["recent", "clock", "Recent", store.recent.length],
          ] as const
        ).map(([id, icon, label, count]) => (
          <button
            key={id}
            onClick={() => store.setTab(id)}
            className={cn(
              "relative z-10 flex items-center justify-center gap-1.5 rounded-[10px] py-1.5 transition-colors duration-200 active:scale-95",
              tab === id ? "text-white" : "text-slate-400 hover:text-slate-200",
            )}
          >
            <Icon name={icon} size={13} fill={id === "favorites" && tab === id ? "currentColor" : "none"} className={tab === id && id === "favorites" ? "text-amber-300" : ""} />
            {label}
            <span className="text-[10px] text-slate-500">{count}</span>
          </button>
        ))}
      </div>

      <div key={tab} className="animate-rise space-y-0.5">
        {tab === "favorites" &&
          (favs.length === 0 ? (
            <Empty icon="star" text="Tap the star on any page to keep it here." />
          ) : (
            favs.map((item) => {
              const active = activeId === item.id;
              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(item.id)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(item.id)}
                  onContextMenu={(e) => openItemMenu(e, item.id, "favorite")}
                  onMouseMove={trackSpotlight}
                  className={cn(
                    "nav-row group/row relative flex h-10 cursor-pointer items-center gap-2.5 rounded-xl px-2 outline-none transition-all duration-200 active:scale-[0.97] focus-visible:ring-1 focus-visible:ring-sky-300/60",
                    active ? "bg-white/10 text-white" : "text-slate-300 hover:text-white",
                  )}
                >
                  <ItemIcon item={item} theme={theme} active={active} size="sm" />
                  <span className="flex-1 truncate text-[13px]">{item.label}</span>
                  <button
                    title="Remove from favorites"
                    onClick={(e) => {
                      e.stopPropagation();
                      store.toggleFavorite(item.id);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-lg text-amber-300 transition-all hover:bg-white/10 active:scale-75"
                  >
                    <Icon name="star" size={13} fill="currentColor" />
                  </button>
                </div>
              );
            })
          ))}

        {tab === "recent" && (
          <>
            {recent.length === 0 ? (
              <Empty icon="clock" text="Your recent pages and downloads will show up here." />
            ) : (
              recent.map((r) => {
                const node = r.itemId ? NAV.index.get(r.itemId) : undefined;
                return (
                  <div
                    key={r.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => node && navigate(node.id)}
                    onKeyDown={(e) => e.key === "Enter" && node && navigate(node.id)}
                    onContextMenu={(e) => openRecentMenu(e, r)}
                    onMouseMove={trackSpotlight}
                    className="nav-row group/row relative flex h-10 cursor-pointer items-center gap-2.5 rounded-xl px-2 text-slate-300 outline-none transition-all duration-200 hover:text-white active:scale-[0.97] focus-visible:ring-1 focus-visible:ring-sky-300/60"
                  >
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                        r.kind === "action" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.06] text-slate-400",
                      )}
                    >
                      <Icon name={r.kind === "action" ? "zap" : "clock"} size={12} stroke={2} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] leading-tight">{r.label}</span>
                      <span className="block text-[10.5px] leading-tight text-slate-500">{timeAgo(r.at, now)}</span>
                    </span>
                    <button
                      title="Remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        store.removeRecent(r.key);
                      }}
                      className="hidden h-6 w-6 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-white/10 hover:text-white active:scale-75 group-hover/row:flex"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                );
              })
            )}
            {recent.length > 0 && (
              <button
                onClick={store.clearRecent}
                className="mt-1 w-full rounded-lg py-1.5 text-center text-[11px] text-slate-500 transition-colors hover:bg-white/5 hover:text-rose-300"
              >
                Clear activity
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Empty({ icon, text }: { icon: "star" | "clock"; text: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-white/10 px-3 py-4 text-center text-[11.5px] leading-snug text-slate-500">
      <Icon name={icon} size={16} />
      {text}
    </div>
  );
}
