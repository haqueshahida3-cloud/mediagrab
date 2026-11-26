import { createContext, useContext, type MouseEvent } from "react";
import type { IconTheme } from "./themes";
import type { SidebarStore } from "./useSidebarStore";
import type { RecentEntry } from "./types";

export type MenuSource = "tree" | "pinned" | "favorite" | "recent";

export interface SidebarCtx {
  store: SidebarStore;
  /** true when the desktop panel is in its slim icon-only state */
  collapsed: boolean;
  theme: IconTheme;
  activeId: string;
  navigate: (id: string) => void;
  openItemMenu: (e: MouseEvent, id: string, source: MenuSource) => void;
  openRecentMenu: (e: MouseEvent, entry: RecentEntry) => void;
  /** collapsed-mode flyout / tooltip trigger */
  hover: (id: string | null, el?: HTMLElement) => void;
  registerRow: (id: string, el: HTMLElement | null) => void;
  toast: (msg: string) => void;
}

export const SidebarContext = createContext<SidebarCtx | null>(null);

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside <GlassSidebar>");
  return ctx;
}
