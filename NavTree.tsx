import { useCallback, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./icons";
import { ItemIcon } from "./ItemIcon";
import { NAV } from "./navData";
import { useSidebar } from "./context";
import type { ResolvedNavItem } from "./types";

/** moves the spotlight highlight with the cursor */
export function trackSpotlight(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--rx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--ry", `${e.clientY - r.top}px`);
}

export function NavTree() {
  const { store, collapsed, activeId, registerRow } = useSidebar();
  const wrapRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const firstPaint = useRef(true);

  /** The row the glass indicator should sit on (the active row, or its nearest visible ancestor) */
  const targetId = useMemo(() => {
    const node = NAV.index.get(activeId);
    if (!node) return null;
    if (collapsed) return node.path[0] ?? node.id;
    for (const pid of node.path) if (!store.expanded.includes(pid)) return pid;
    return node.id;
  }, [activeId, collapsed, store.expanded]);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const ind = indRef.current;
    if (!wrap || !ind) return;
    const el = targetId ? rowEls.current.get(targetId) : null;
    if (!el) {
      ind.style.opacity = "0";
      return;
    }
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (firstPaint.current) {
      ind.style.transition = "none";
    }
    ind.style.opacity = "1";
    ind.style.height = `${r.height}px`;
    ind.style.width = `${r.width}px`;
    ind.style.transform = `translate(${r.left - w.left}px, ${r.top - w.top}px)`;
    if (firstPaint.current) {
      firstPaint.current = false;
      void ind.offsetHeight;
      requestAnimationFrame(() => {
        ind.style.transition = "";
      });
    }
  }, [targetId]);

  // follow the target while groups animate / sidebar resizes
  useLayoutEffect(() => {
    measure();
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      measure();
      if (performance.now() - start < 520) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [measure, store.expanded, collapsed, store.width]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  const reg = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (el) rowEls.current.set(id, el);
      else rowEls.current.delete(id);
      registerRow(id, el);
    },
    [registerRow],
  );

  return (
    <div ref={wrapRef} className="relative" role="tree" aria-label="Main navigation">
      {/* animated glass active indicator */}
      <div
        ref={indRef}
        className="nav-indicator pointer-events-none absolute left-0 top-0 z-0 opacity-0"
        aria-hidden="true"
      >
        <span className="nav-indicator-bar" />
      </div>
      <div className="space-y-0.5">
        {NAV.tree.map((item, i) => (
          <NavNode key={item.id} item={item} reg={reg} index={i} />
        ))}
      </div>
    </div>
  );
}

interface NodeProps {
  item: ResolvedNavItem;
  reg: (id: string, el: HTMLElement | null) => void;
  index?: number;
}

function NavNode({ item, reg, index = 0 }: NodeProps) {
  const { store, collapsed, theme, activeId, navigate, openItemMenu, hover } = useSidebar();
  const isGroup = !!item.children;
  const open = isGroup && !collapsed && store.expanded.includes(item.id);
  const active = activeId === item.id;
  const containsActive = isGroup && !!NAV.index.get(activeId)?.path.includes(item.id);
  const top = item.level === 0;
  const pinned = store.pinned.includes(item.id);
  const fav = store.favorites.includes(item.id);

  const activate = () => {
    if (!isGroup) return navigate(item.id);
    if (collapsed) {
      store.setCollapsed(false);
      store.setGroupsOpen([item.id], true);
    } else store.toggleGroup(item.id);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    } else if (e.key === "ArrowRight" && isGroup && !open) {
      e.preventDefault();
      store.setGroupsOpen([item.id], true);
    } else if (e.key === "ArrowLeft" && isGroup && open) {
      e.preventDefault();
      store.setGroupsOpen([item.id], false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = Array.from(
        e.currentTarget.closest("[role=tree]")?.querySelectorAll<HTMLElement>("[data-row]") ?? [],
      ).filter((el) => el.offsetParent !== null);
      const i = all.indexOf(e.currentTarget);
      all[i + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  };

  return (
    <div
      className="animate-rise"
      style={top ? { animationDelay: `${60 + index * 35}ms` } : undefined}
      role="none"
    >
      <div
        ref={(el) => reg(item.id, el)}
        data-row
        role="treeitem"
        aria-expanded={isGroup ? open : undefined}
        aria-current={active ? "page" : undefined}
        aria-selected={active}
        tabIndex={0}
        draggable={!isGroup}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/mg-nav", item.id);
          e.dataTransfer.effectAllowed = "copyMove";
        }}
        onClick={activate}
        onKeyDown={onKey}
        onContextMenu={(e) => openItemMenu(e, item.id, "tree")}
        onMouseMove={trackSpotlight}
        onMouseEnter={(e) => collapsed && hover(item.id, e.currentTarget)}
        onMouseLeave={() => collapsed && hover(null)}
        className={cn(
          "nav-row group/row relative z-10 flex cursor-pointer select-none items-center rounded-[14px] outline-none",
          "transition-[color,transform] duration-200 active:scale-[0.97]",
          "focus-visible:ring-1 focus-visible:ring-sky-300/60",
          top ? "h-11 px-[10px]" : "h-9 px-2",
          active ? "text-white" : containsActive ? "text-slate-100" : "text-slate-300 hover:text-white",
        )}
      >
        <ItemIcon item={item} theme={theme} active={active} size={top ? "lg" : "sm"} />

        <span
          className={cn(
            "truncate whitespace-nowrap transition-all duration-300",
            top ? "text-[14px] font-medium" : "text-[13px]",
            collapsed ? "ml-0 w-0 opacity-0" : "ml-3 flex-1 opacity-100",
          )}
        >
          {item.label}
        </span>

        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 overflow-hidden transition-all duration-300",
            collapsed ? "max-w-0 opacity-0" : "max-w-[96px] opacity-100",
          )}
        >
          {item.badge && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
              style={{ background: `${item.hue}26`, color: item.hue, boxShadow: `inset 0 0 0 1px ${item.hue}40` }}
            >
              {item.badge}
            </span>
          )}

          {!isGroup && (
            <>
              {fav && <Icon name="star" size={12} fill="currentColor" className="text-amber-300 group-hover/row:hidden" />}
              {pinned && !fav && <Icon name="pin" size={12} className="text-sky-300/80 group-hover/row:hidden" />}
              <span className="hidden items-center gap-0.5 group-hover/row:flex">
                <MiniAction
                  label={fav ? "Remove favorite" : "Add to favorites"}
                  on={fav}
                  onTone="text-amber-300"
                  icon="star"
                  onClick={() => store.toggleFavorite(item.id)}
                />
                <MiniAction
                  label={pinned ? "Unpin" : "Pin shortcut"}
                  on={pinned}
                  onTone="text-sky-300"
                  icon="pin"
                  onClick={() => store.togglePin(item.id)}
                />
              </span>
            </>
          )}

          {isGroup && (
            <Icon
              name="chevron"
              size={15}
              stroke={2}
              className={cn(
                "text-slate-400 transition-transform duration-300 group-hover/row:text-white",
                open && "rotate-90",
              )}
            />
          )}
        </span>

        {collapsed && item.badge && (
          <span
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-[#0d0f24]"
            style={{ background: item.hue, boxShadow: `0 0 8px ${item.hue}` }}
          />
        )}
      </div>

      {isGroup && (
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.32,.72,0,1)]",
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
          aria-hidden={!open}
        >
          <div className="min-h-0 overflow-hidden" role="group" inert={!open}>
            <div className={cn("space-y-0.5 pb-1 pt-0.5", top ? "ml-[25px] border-l border-white/[0.07] pl-2" : "ml-[15px] border-l border-white/[0.07] pl-2")}>
              {item.children!.map((c) => (
                <NavNode key={c.id} item={c} reg={reg} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniAction({
  label,
  on,
  onTone,
  icon,
  onClick,
}: {
  label: string;
  on: boolean;
  onTone: string;
  icon: "star" | "pin";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseMove={(e) => e.stopPropagation()}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-lg transition-all duration-150 hover:bg-white/15 active:scale-75",
        on ? onTone : "text-slate-400 hover:text-white",
      )}
    >
      <Icon name={icon} size={13} stroke={2} fill={on ? "currentColor" : "none"} />
    </button>
  );
}
