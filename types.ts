import type { IconName } from "./icons";

export interface NavItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Accent colour (hex). Children inherit from their parent when omitted. */
  hue?: string;
  badge?: string;
  description?: string;
  /** Page type — used by the demo App to decide which action card to show. */
  kind?: "home" | "download" | "tool" | "ai" | "library" | "info";
  children?: NavItem[];
}

export interface ResolvedNavItem extends NavItem {
  hue: string;
  level: number;
  /** Ancestor ids from the root down to (but excluding) this item. */
  path: string[];
  parentId?: string;
  children?: ResolvedNavItem[];
}

export interface RecentEntry {
  /** unique entry id */
  key: string;
  label: string;
  /** Navigation item this entry points to (if any) */
  itemId?: string;
  kind: "visit" | "action";
  at: number;
}

export type SidebarTab = "favorites" | "recent";
