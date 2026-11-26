import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../utils/cn";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { Flyout } from "./Flyout";
import { Icon } from "./icons";
import { NAV, collectGroupIds } from "./navData";
import { NavTree } from "./NavTree";
import { PinnedShortcuts, SectionLabel } from "./PinnedShortcuts";
import { QuickLists } from "./QuickLists";
import { SettingsPopover } from "./SettingsPopover";
import { SidebarContext, type MenuSource, type SidebarCtx } from "./context";
import { ICON_THEMES, getTheme } from "./themes";
import { COLLAPSED_W, DEFAULT_W, MIN_W, type SidebarStore } from "./useSidebarStore";
import type { RecentEntry } from "./types";

interface Props {
  store: SidebarStore;
  activeId: string;
  onNavigate: (id: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  title?: string;
  entries: MenuEntry[];
}

const COLLAPSE_SNAP = 168;

export function GlassSidebar({ store, activeId, onNavigate }: Props) {
  const collapsed = !store.isMobile && store.collapsed;
  const theme = getTheme(store.themeId);

  const rows = useRef(new Map<string, HTMLElement>());
  const registerRow = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  }, []);

  /* ---------- toast ---------- */
  const [toastMsg, setToastMsg] = useState<{ text: string; id: number } | null>(null);
  const toastTimer = useRef<number>(0);
  const toast = useCallback((text: string) => {
    window.clearTimeout(toastTimer.current);
    setToastMsg({ text, id: Date.now() });
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2200);
  }, []);

  /* ---------- navigation ---------- */
  const navigate = useCallback(
    (id: string) => {
      store.expandPath(id);
      if (id !== activeId) store.logVisit(id);
      onNavigate(id);
      setFlyout(null);
      if (store.isMobile) store.setMobileOpen(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.expandPath, store.logVisit, store.isMobile, store.setMobileOpen, onNavigate, activeId],
  );

  const reveal = useCallback(
    (id: string) => {
      store.setCollapsed(false);
      store.expandPath(id);
      window.setTimeout(() => {
        const el = rows.current.get(id);
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("row-flash");
        window.setTimeout(() => el.classList.remove("row-flash"), 1400);
      }, 340);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.setCollapsed, store.expandPath],
  );

  /* ---------- collapsed hover flyout ---------- */
  const [flyout, setFlyout] = useState<{ id: string; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<number>(0);
  const hover = useCallback((id: string | null, el?: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    if (id && el) hoverTimer.current = window.setTimeout(() => setFlyout({ id, rect: el.getBoundingClientRect() }), 70);
    else hoverTimer.current = window.setTimeout(() => setFlyout(null), 160);
  }, []);
  useEffect(() => {
    if (!collapsed) setFlyout(null);
  }, [collapsed]);

  /* ---------- context menus ---------- */
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const copyLink = (id: string) => {
    const url = `${location.origin}${location.pathname}#${id}`;
    navigator.clipboard?.writeText(url).then(
      () => toast("Link copied"),
      () => toast("Couldn't copy link"),
    );
  };

  const openItemMenu = useCallback(
    (e: MouseEvent, id: string, source: MenuSource) => {
      e.preventDefault();
      e.stopPropagation();
      const node = NAV.index.get(id);
      if (!node) return;
      setFlyout(null);
      const entries: MenuEntry[] = [];

      if (node.children) {
        const open = store.expanded.includes(id);
        const inner = collectGroupIds(node.children);
        entries.push(
          open
            ? { type: "item", label: "Collapse group", icon: "collapseAll", onClick: () => store.setGroupsOpen([id], false) }
            : { type: "item", label: "Expand group", icon: "expandAll", onClick: () => store.setGroupsOpen([id], true) },
        );
        if (inner.length)
          entries.push(
            { type: "item", label: "Expand everything inside", icon: "expandAll", onClick: () => store.setGroupsOpen([id, ...inner], true) },
            { type: "item", label: "Collapse sub-groups", icon: "collapseAll", onClick: () => store.setGroupsOpen(inner, false) },
          );
        entries.push({ type: "sep" }, { type: "item", label: "Copy link", icon: "link", onClick: () => copyLink(id) });
      } else {
        const pinned = store.pinned.includes(id);
        const fav = store.favorites.includes(id);
        entries.push(
          activeId === id
            ? { type: "label", text: "You are here" }
            : { type: "item", label: "Open", icon: "arrowRight", hint: "↵", onClick: () => navigate(id) },
          { type: "sep" },
          {
            type: "item",
            label: pinned ? "Unpin shortcut" : "Pin as shortcut",
            icon: "pin",
            onClick: () => {
              store.togglePin(id);
              toast(pinned ? `Unpinned “${node.label}”` : `Pinned “${node.label}”`);
            },
          },
          {
            type: "item",
            label: fav ? "Remove from favorites" : "Add to favorites",
            icon: "star",
            onClick: () => {
              store.toggleFavorite(id);
              toast(fav ? "Removed from favorites" : `“${node.label}” added to favorites`);
            },
          },
        );
        if (source === "pinned") {
          const i = store.pinned.indexOf(id);
          entries.push(
            { type: "sep" },
            { type: "item", label: "Move earlier", icon: "arrowLeft", disabled: i <= 0, onClick: () => store.movePinned(id, -1) },
            {
              type: "item",
              label: "Move later",
              icon: "arrowRight",
              disabled: i >= store.pinned.length - 1,
              onClick: () => store.movePinned(id, 1),
            },
          );
        }
        if (source !== "tree")
          entries.push({ type: "sep" }, { type: "item", label: "Show in menu", icon: "eye", onClick: () => reveal(id) });
        entries.push(
          { type: "sep" },
          { type: "item", label: "Copy link", icon: "link", onClick: () => copyLink(id) },
          { type: "item", label: "Open in new tab", icon: "external", onClick: () => window.open(`#${id}`, "_blank") },
        );
      }
      setMenu({ x: e.clientX, y: e.clientY, title: node.label, entries });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, activeId, navigate, reveal, toast],
  );

  const openRecentMenu = useCallback(
    (e: MouseEvent, entry: RecentEntry) => {
      e.preventDefault();
      e.stopPropagation();
      const entries: MenuEntry[] = [];
      if (entry.itemId)
        entries.push(
          { type: "item", label: "Open again", icon: "arrowRight", onClick: () => navigate(entry.itemId!) },
          { type: "item", label: "Show in menu", icon: "eye", onClick: () => reveal(entry.itemId!) },
          { type: "sep" },
        );
      entries.push(
        { type: "item", label: "Remove from activity", icon: "x", onClick: () => store.removeRecent(entry.key) },
        { type: "item", label: "Clear all activity", icon: "trash", danger: true, onClick: store.clearRecent },
      );
      setMenu({ x: e.clientX, y: e.clientY, title: "Recent activity", entries });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, navigate, reveal],
  );

  const openPanelMenu = (e: MouseEvent) => {
    e.preventDefault();
    setFlyout(null);
    const entries: MenuEntry[] = [
      {
        type: "item",
        label: collapsed ? "Expand sidebar" : "Collapse sidebar",
        icon: "panel",
        hint: "Ctrl B",
        onClick: store.toggleCollapsed,
      },
      { type: "item", label: "Reset width", icon: "arrowRight", disabled: collapsed || store.width === DEFAULT_W, onClick: () => store.setWidth(DEFAULT_W) },
      { type: "sep" },
      { type: "item", label: "Expand all groups", icon: "expandAll", onClick: store.expandAll },
      { type: "item", label: "Collapse all groups", icon: "collapseAll", onClick: store.collapseAll },
      { type: "sep" },
      { type: "label", text: "Icon theme" },
      ...ICON_THEMES.map<MenuEntry>((t) => ({
        type: "item",
        label: t.name,
        icon: "palette",
        checked: store.themeId === t.id,
        onClick: () => store.setThemeId(t.id),
      })),
      { type: "sep" },
      { type: "item", label: "Reset sidebar", icon: "reset", danger: true, onClick: () => { store.reset(); toast("Sidebar reset to defaults"); } },
    ];
    setMenu({ x: e.clientX, y: e.clientY, title: "Sidebar", entries });
  };

  /* ---------- settings popover ---------- */
  const [settingsRect, setSettingsRect] = useState<DOMRect | null>(null);
  const closeSettings = useCallback(() => setSettingsRect(null), []);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (store.isMobile) store.setMobileOpen(!store.mobileOpen);
        else store.toggleCollapsed();
      } else if (e.key === "Escape" && store.mobileOpen) store.setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  /* ---------- spotlight + resize ---------- */
  const panelRef = useRef<HTMLDivElement>(null);
  const onPanelMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  const [resizing, setResizing] = useState(false);
  const drag = useRef({ x: 0, w: DEFAULT_W });
  const onResizeStart = (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: collapsed ? COLLAPSED_W : store.width };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onResizeMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    const raw = drag.current.w + (e.clientX - drag.current.x);
    if (raw < COLLAPSE_SNAP) store.setCollapsed(true);
    else {
      store.setCollapsed(false);
      store.setWidth(raw);
    }
  };
  const onResizeEnd = (e: RPointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const ctx: SidebarCtx = useMemo(
    () => ({ store, collapsed, theme, activeId, navigate, openItemMenu, openRecentMenu, hover, registerRow, toast }),
    [store, collapsed, theme, activeId, navigate, openItemMenu, openRecentMenu, hover, registerRow, toast],
  );

  const widthPx = store.isMobile ? "min(320px, calc(100vw - 24px))" : `${collapsed ? COLLAPSED_W : store.width}px`;
  const hiddenMobile = store.isMobile && !store.mobileOpen;

  return (
    <SidebarContext.Provider value={ctx}>
      {store.isMobile && (
        <div
          onClick={() => store.setMobileOpen(false)}
          className={cn(
            "fixed inset-0 z-30 bg-black/50 backdrop-blur-sm transition-opacity duration-300",
            store.mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      )}

      <aside
        aria-label="Sidebar"
        className={cn(
          "fixed bottom-3 left-3 top-3 z-40 transition-[width,transform] duration-[380ms] ease-[cubic-bezier(.32,.72,0,1)]",
          resizing && "sidebar-resizing !transition-none",
        )}
        style={{ width: widthPx, transform: hiddenMobile ? "translateX(-120%)" : "none" }}
      >
        <div
          ref={panelRef}
          onMouseMove={onPanelMove}
          onContextMenu={openPanelMenu}
          className="glass-panel relative h-full overflow-hidden rounded-[28px]"
        >
          {/* ambient blue-violet glow */}
          <div className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 animate-drift rounded-full bg-blue-500/30 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -right-24 h-72 w-72 animate-drift-slow rounded-full bg-violet-500/30 blur-3xl" />
          <div className="panel-spotlight pointer-events-none absolute inset-0" />

          <div className="relative flex h-full flex-col">
            {/* ---------- header ---------- */}
            <div className="flex h-[68px] shrink-0 items-center px-3">
              <button
                onClick={() => (collapsed ? store.setCollapsed(false) : navigate("home"))}
                className="group/logo relative ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-gradient-to-br from-sky-400 via-indigo-500 to-violet-500 text-white shadow-[0_8px_24px_-6px_rgba(99,102,241,.9),inset_0_1px_0_rgba(255,255,255,.4)] transition-transform duration-300 hover:scale-105 active:scale-90"
                aria-label={collapsed ? "Expand sidebar" : "Go home"}
              >
                <Icon
                  name="download"
                  size={20}
                  stroke={2.25}
                  className={cn("transition-all duration-300", collapsed && "group-hover/logo:-translate-y-8 group-hover/logo:opacity-0")}
                />
                {collapsed && (
                  <Icon
                    name="arrowRight"
                    size={20}
                    stroke={2.25}
                    className="absolute translate-y-8 opacity-0 transition-all duration-300 group-hover/logo:translate-y-0 group-hover/logo:opacity-100"
                  />
                )}
              </button>
              <div
                className={cn(
                  "min-w-0 overflow-hidden whitespace-nowrap transition-all duration-300",
                  collapsed ? "ml-0 w-0 opacity-0" : "ml-3 flex-1 opacity-100",
                )}
              >
                <div className="text-[15px] font-semibold leading-tight tracking-tight text-white">MediaGrab</div>
                <div className="flex items-center gap-1 text-[11px] leading-tight text-slate-400">
                  <Icon name="sparkles" size={10} className="text-violet-300" /> AI media studio
                </div>
              </div>
              {!store.isMobile && (
                <button
                  onClick={store.toggleCollapsed}
                  title="Collapse sidebar (Ctrl+B)"
                  aria-label="Collapse sidebar"
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-all duration-300 hover:bg-white/10 hover:text-white active:scale-90",
                    collapsed && "pointer-events-none w-0 opacity-0",
                  )}
                >
                  <Icon name="panel" size={18} />
                </button>
              )}
              {store.isMobile && (
                <button
                  onClick={() => store.setMobileOpen(false)}
                  aria-label="Close menu"
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-white/10 hover:text-white active:scale-90"
                >
                  <Icon name="x" size={18} />
                </button>
              )}
            </div>

            {/* ---------- body ---------- */}
            <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1">
              <PinnedShortcuts />
              <div>
                {!collapsed && (
                  <SectionLabel
                    right={
                      <button
                        title="Expand / collapse all"
                        onClick={() => (store.expanded.length ? store.collapseAll() : store.expandAll())}
                        className="flex h-5 w-5 items-center justify-center rounded-md text-slate-500 transition-all hover:bg-white/10 hover:text-white active:scale-75"
                      >
                        <Icon name={store.expanded.length ? "collapseAll" : "expandAll"} size={13} />
                      </button>
                    }
                  >
                    Navigate
                  </SectionLabel>
                )}
                {collapsed && <div className="mb-3 border-t border-white/[0.07]" />}
                <NavTree />
              </div>
              <QuickLists />
            </div>

            {/* ---------- footer ---------- */}
            <div className="shrink-0 border-t border-white/[0.07] p-3">
              <div className={cn("flex items-center rounded-2xl", collapsed ? "justify-center" : "gap-2.5 bg-white/[0.04] p-2 ring-1 ring-white/[0.07]")}>
                {!collapsed && (
                  <>
                    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-sky-400 text-[13px] font-bold text-slate-900">
                      G
                      <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-[#0d0f24]" />
                    </div>
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate text-[13px] font-medium text-white">Guest</div>
                      <div className="truncate text-[11px] text-slate-400">100% free · no signup</div>
                    </div>
                  </>
                )}
                <button
                  data-settings-btn
                  title="Appearance & layout"
                  aria-label="Appearance and layout"
                  onClick={(e) =>
                    setSettingsRect((r) => (r ? null : (e.currentTarget as HTMLElement).getBoundingClientRect()))
                  }
                  className={cn(
                    "group/row flex items-center justify-center rounded-xl text-slate-400 transition-all duration-200 hover:bg-white/10 hover:text-white active:scale-90",
                    collapsed ? "h-11 w-full" : "h-9 w-9",
                    settingsRect && "bg-white/10 text-white",
                  )}
                >
                  <Icon name="palette" size={18} className="transition-transform duration-500 group-hover/row:rotate-[24deg] group-hover/row:scale-110" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ---------- resize handle ---------- */}
        {!store.isMobile && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_W}
            aria-valuenow={collapsed ? COLLAPSED_W : store.width}
            tabIndex={0}
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onDoubleClick={() => {
              store.setCollapsed(false);
              store.setWidth(DEFAULT_W);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") store.setWidth(store.width - 16);
              if (e.key === "ArrowRight") store.setWidth(store.width + 16);
            }}
            title="Drag to resize · double-click to reset"
            className="group/handle absolute -right-3 bottom-10 top-10 z-20 flex w-6 cursor-col-resize items-center justify-center outline-none"
          >
            <span
              className={cn(
                "h-16 w-1 rounded-full bg-white/20 transition-all duration-200 group-hover/handle:h-24 group-hover/handle:bg-sky-300/70 group-hover/handle:shadow-[0_0_14px_2px_rgba(125,211,252,.5)] group-focus-visible/handle:bg-sky-300",
                resizing && "!h-28 !bg-sky-300 shadow-[0_0_18px_3px_rgba(125,211,252,.7)]",
              )}
            />
            {resizing && (
              <span className="animate-pop absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900/80 px-2 py-1 font-mono text-[11px] text-sky-200 ring-1 ring-white/15 backdrop-blur">
                {collapsed ? "collapsed" : `${store.width}px`}
              </span>
            )}
          </div>
        )}
      </aside>

      {flyout && collapsed && (
        <Flyout
          id={flyout.id}
          rect={flyout.rect}
          onEnter={() => window.clearTimeout(hoverTimer.current)}
          onLeave={() => hover(null)}
        />
      )}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      {settingsRect && <SettingsPopover anchor={settingsRect} store={store} onClose={closeSettings} toast={toast} />}
      {toastMsg &&
        createPortal(
          <div
            key={toastMsg.id}
            className="glass-pop animate-toast pointer-events-none fixed bottom-6 left-1/2 z-[120] flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] text-white"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300">
              <Icon name="check" size={12} stroke={3} />
            </span>
            {toastMsg.text}
          </div>,
          document.body,
        )}
    </SidebarContext.Provider>
  );
}
