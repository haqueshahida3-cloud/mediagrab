import { useState, type DragEvent } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./icons";
import { ItemIcon } from "./ItemIcon";
import { NAV } from "./navData";
import { useSidebar } from "./context";
import { trackSpotlight } from "./NavTree";

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500">
      <span>{children}</span>
      {right}
    </div>
  );
}

/** Customisable pinned shortcuts: drag to reorder, drop pages from the tree to pin, right-click for options. */
export function PinnedShortcuts() {
  const { store, collapsed, theme, activeId, navigate, openItemMenu, hover, toast } = useSidebar();
  const [over, setOver] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const items = store.pinned.map((id) => NAV.index.get(id)).filter((x): x is NonNullable<typeof x> => !!x);

  const dropAt = (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/mg-nav");
    const node = id ? NAV.index.get(id) : undefined;
    if (!node || node.children) return reset();
    const from = store.pinned.indexOf(id);
    let at = over ?? store.pinned.length;
    if (from >= 0 && from < at) at -= 1;
    store.pinItem(id, at);
    if (from < 0) toast(`Pinned “${node.label}”`);
    reset();
  };
  const reset = () => {
    setOver(null);
    setDragging(false);
  };

  const hint = (e: DragEvent, i: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = e.currentTarget.getBoundingClientRect();
    const after = collapsed ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    setOver(i + (after ? 1 : 0));
    setDragging(true);
  };

  return (
    <section
      aria-label="Pinned shortcuts"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/mg-nav")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) reset();
      }}
      onDrop={dropAt}
    >
      {!collapsed && (
        <SectionLabel
          right={
            <span className="flex items-center gap-1 text-[10px] font-medium normal-case tracking-normal text-slate-500">
              <Icon name="pin" size={10} />
              {items.length}
            </span>
          }
        >
          Pinned
        </SectionLabel>
      )}

      {items.length === 0 ? (
        <div
          className={cn(
            "rounded-2xl border border-dashed px-3 py-3 text-center text-[11.5px] leading-snug transition-all duration-200",
            dragging ? "scale-[1.02] border-sky-300/60 bg-sky-400/10 text-sky-200" : "border-white/10 text-slate-500",
            collapsed && "px-0 py-2 text-[0px]",
          )}
        >
          {collapsed ? <Icon name="pin" size={16} className="mx-auto text-slate-500" /> : "Drag a page here or right‑click → Pin"}
        </div>
      ) : (
        <div className={cn(collapsed ? "grid grid-cols-1 gap-0.5" : "grid grid-cols-4 gap-1")}>
          {items.map((item, i) => {
            const active = activeId === item.id;
            const barBefore = over === i;
            const barAfter = over === items.length && i === items.length - 1;
            return (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/mg-nav", item.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => hint(e, i)}
                onDragEnd={reset}
                onClick={() => navigate(item.id)}
                onContextMenu={(e) => openItemMenu(e, item.id, "pinned")}
                onMouseMove={trackSpotlight}
                onMouseEnter={(e) => collapsed && hover(item.id, e.currentTarget)}
                onMouseLeave={() => collapsed && hover(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(item.id);
                  }
                }}
                role="button"
                tabIndex={0}
                title={collapsed ? undefined : item.label}
                aria-label={`Pinned: ${item.label}`}
                className={cn(
                  "nav-row group/row relative flex cursor-pointer select-none items-center justify-center rounded-[14px] outline-none",
                  "transition-all duration-200 active:scale-90 focus-visible:ring-1 focus-visible:ring-sky-300/60",
                  collapsed ? "h-11 px-[10px]" : "animate-rise flex-col gap-1 px-0.5 py-2",
                  active ? "bg-white/10 ring-1 ring-white/15" : "",
                )}
                style={collapsed ? undefined : { animationDelay: `${i * 40}ms` }}
              >
                {barBefore && <DropBar collapsed={collapsed} side="start" />}
                {barAfter && <DropBar collapsed={collapsed} side="end" />}
                <ItemIcon item={item} theme={theme} active={active} />
                {!collapsed && (
                  <span
                    className={cn(
                      "w-full truncate px-0.5 text-center text-[10.5px] leading-none",
                      active ? "text-white" : "text-slate-400 group-hover/row:text-white",
                    )}
                  >
                    {item.label.split(" ")[0]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DropBar({ collapsed, side }: { collapsed: boolean; side: "start" | "end" }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute rounded-full bg-sky-300 shadow-[0_0_10px_2px_rgba(125,211,252,.7)]",
        collapsed
          ? cn("inset-x-2 h-0.5", side === "start" ? "-top-px" : "-bottom-px")
          : cn("inset-y-2 w-0.5", side === "start" ? "-left-0.5" : "-right-0.5"),
      )}
    />
  );
}
