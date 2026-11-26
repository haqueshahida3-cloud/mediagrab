import { useCallback, useEffect, useState } from "react";
import { NAV, collectGroupIds } from "./navData";
import { DEFAULT_THEME, type IconThemeId } from "./themes";
import type { RecentEntry, SidebarTab } from "./types";

export const MIN_W = 236;
export const MAX_W = 420;
export const DEFAULT_W = 292;
export const COLLAPSED_W = 76;
export const MOBILE_BREAKPOINT = 768;

const PREFIX = "mg.sidebar.v1.";

function usePersisted<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      /* ignore */
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

const DEFAULT_PINNED = ["dl-youtube", "tool-convert-audio", "ai-summary", "lib-downloads"];
const DEFAULT_FAVORITES = ["dl-mp3", "ai-transcribe"];
const DEFAULT_EXPANDED = ["downloader", "dl-video"];

const seedRecent = (): RecentEntry[] => {
  const now = Date.now();
  const min = 60_000;
  return [
    { key: "seed-1", label: "Downloaded “Lo-fi mix.mp3”", itemId: "dl-mp3", kind: "action", at: now - 4 * min },
    { key: "seed-2", label: "Image Converter", itemId: "tool-image", kind: "visit", at: now - 38 * min },
    { key: "seed-3", label: "Smart Summary", itemId: "ai-summary", kind: "visit", at: now - 3 * 60 * min },
  ];
};

function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${MOBILE_BREAKPOINT - 1}px)`);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export function useSidebarStore() {
  const [collapsed, setCollapsed] = usePersisted<boolean>("collapsed", false);
  const [width, setWidthRaw] = usePersisted<number>("width", DEFAULT_W);
  const [expanded, setExpanded] = usePersisted<string[]>("expanded", DEFAULT_EXPANDED);
  const [pinned, setPinned] = usePersisted<string[]>("pinned", DEFAULT_PINNED);
  const [favorites, setFavorites] = usePersisted<string[]>("favorites", DEFAULT_FAVORITES);
  const [recent, setRecent] = usePersisted<RecentEntry[]>("recent", seedRecent);
  const [themeId, setThemeId] = usePersisted<IconThemeId>("theme", DEFAULT_THEME);
  const [tab, setTab] = usePersisted<SidebarTab>("tab", "favorites");
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();

  const setWidth = useCallback(
    (w: number) => setWidthRaw(Math.round(Math.min(MAX_W, Math.max(MIN_W, w)))),
    [setWidthRaw],
  );

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), [setCollapsed]);

  const toggleGroup = useCallback(
    (id: string) => setExpanded((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id])),
    [setExpanded],
  );

  const setGroupsOpen = useCallback(
    (ids: string[], open: boolean) =>
      setExpanded((e) => (open ? Array.from(new Set([...e, ...ids])) : e.filter((x) => !ids.includes(x)))),
    [setExpanded],
  );

  const expandPath = useCallback(
    (id: string) => {
      const node = NAV.index.get(id);
      if (!node || node.path.length === 0) return;
      setExpanded((e) => Array.from(new Set([...e, ...node.path])));
    },
    [setExpanded],
  );

  const togglePin = useCallback(
    (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
    [setPinned],
  );

  const pinItem = useCallback(
    (id: string, at?: number) =>
      setPinned((p) => {
        const without = p.filter((x) => x !== id);
        const i = at === undefined ? without.length : Math.max(0, Math.min(without.length, at));
        return [...without.slice(0, i), id, ...without.slice(i)];
      }),
    [setPinned],
  );

  const movePinned = useCallback(
    (id: string, dir: -1 | 1) =>
      setPinned((p) => {
        const i = p.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= p.length) return p;
        const next = [...p];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
      }),
    [setPinned],
  );

  const toggleFavorite = useCallback(
    (id: string) => setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : [id, ...f])),
    [setFavorites],
  );

  const logVisit = useCallback(
    (id: string) => {
      const node = NAV.index.get(id);
      if (!node) return;
      setRecent((r) =>
        [
          { key: `v-${id}-${Date.now()}`, label: node.label, itemId: id, kind: "visit" as const, at: Date.now() },
          ...r.filter((x) => !(x.kind === "visit" && x.itemId === id)),
        ].slice(0, 15),
      );
    },
    [setRecent],
  );

  const logAction = useCallback(
    (label: string, itemId?: string) =>
      setRecent((r) =>
        [{ key: `a-${Date.now()}`, label, itemId, kind: "action" as const, at: Date.now() }, ...r].slice(0, 15),
      ),
    [setRecent],
  );

  const removeRecent = useCallback((key: string) => setRecent((r) => r.filter((x) => x.key !== key)), [setRecent]);
  const clearRecent = useCallback(() => setRecent([]), [setRecent]);

  const reset = useCallback(() => {
    setCollapsed(false);
    setWidthRaw(DEFAULT_W);
    setExpanded(DEFAULT_EXPANDED);
    setPinned(DEFAULT_PINNED);
    setFavorites(DEFAULT_FAVORITES);
    setThemeId(DEFAULT_THEME);
    setTab("favorites");
  }, [setCollapsed, setWidthRaw, setExpanded, setPinned, setFavorites, setThemeId, setTab]);

  const expandAll = useCallback(() => setExpanded(collectGroupIds()), [setExpanded]);
  const collapseAll = useCallback(() => setExpanded([]), [setExpanded]);

  /** the real, rendered width of the panel (px) — use this to offset your page content */
  const panelWidth = isMobile ? 0 : collapsed ? COLLAPSED_W : width;

  return {
    collapsed,
    setCollapsed,
    toggleCollapsed,
    width,
    setWidth,
    expanded,
    toggleGroup,
    setGroupsOpen,
    expandPath,
    expandAll,
    collapseAll,
    pinned,
    togglePin,
    pinItem,
    movePinned,
    favorites,
    toggleFavorite,
    recent,
    logVisit,
    logAction,
    removeRecent,
    clearRecent,
    themeId,
    setThemeId,
    tab,
    setTab,
    mobileOpen,
    setMobileOpen,
    isMobile,
    panelWidth,
    reset,
  };
}

export type SidebarStore = ReturnType<typeof useSidebarStore>;
