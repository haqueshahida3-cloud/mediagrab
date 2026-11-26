# MediaGrab — Glass Sidebar

A floating, frosted-glass, resizable sidebar (React 19 + Vite + Tailwind CSS v4). No UI libraries — icons are inline SVG.

## Run the demo

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs dist/index.html
```

## Features

| Feature | Where |
| --- | --- |
| Collapsible sidebar (Ctrl/⌘ + B, logo, header button, drag past the edge) | `GlassSidebar.tsx`, `useSidebarStore.ts` |
| Floating glass panel, backdrop blur, thin illuminated border, blue-violet glow | `src/index.css` (`.glass-panel`, `.glass-pop`) |
| Animated glass active indicator (follows nested rows, even inside collapsed groups) | `NavTree.tsx`, `.nav-indicator` in CSS |
| Multi-level expandable navigation (any depth) | `navData.ts`, `NavTree.tsx` |
| Pinned shortcuts (drag to pin, drag to reorder, right-click → move) | `PinnedShortcuts.tsx` |
| Favorites + Recent activity (tabs) | `QuickLists.tsx` |
| Context-aware right-click menus (page / group / pinned / favorite / recent / panel) | `GlassSidebar.tsx`, `ContextMenu.tsx` |
| Resize (drag the glowing edge, double-click = reset, ←/→ keys) | `GlassSidebar.tsx` |
| Micro-interactions (cursor spotlight, icon tilt, press scale, staggered entrance, toasts) | everywhere + CSS |
| Custom icon themes: Outline · Tinted · Neon · Gradient | `themes.ts`, `ItemIcon.tsx`, `SettingsPopover.tsx` |
| Collapsed-mode hover flyouts (tooltip for pages, sub-menu for groups) | `Flyout.tsx` |
| Mobile drawer | `GlassSidebar.tsx` |
| Everything persisted in `localStorage` (`mg.sidebar.v1.*`) | `useSidebarStore.ts` |

## Add it to your own React project

1. Copy the folder `src/components/sidebar/` and `src/utils/cn.ts` into your project.
2. `npm i clsx tailwind-merge` (and Tailwind CSS v4 with `@tailwindcss/vite`, if you don't have it).
3. Copy everything **below the first line** of `src/index.css` into your global CSS.
4. Edit `src/components/sidebar/navData.ts` — this is your menu tree (labels, icons, colours, badges, nesting).
   Icons come from `icons.tsx` (add your own paths to the `ICONS` object).
5. Use it:

```tsx
import { GlassSidebar, useSidebarStore } from "./components/sidebar";

export default function App() {
  const store = useSidebarStore();
  const [active, setActive] = useState("home");

  return (
    <>
      <GlassSidebar store={store} activeId={active} onNavigate={setActive} />
      {/* offset your page by the sidebar width */}
      <main style={{ paddingLeft: store.isMobile ? 0 : store.panelWidth + 44 }}>…</main>
    </>
  );
}
```

Log your own events into "Recent activity":

```ts
store.logAction("Downloaded “song.mp3”", "dl-mp3"); // label, optional nav item id
```

## Tweaking

* **Colours / glow** — `.glass-panel`, `.glass-pop`, `.nav-indicator` in `index.css`.
* **Sizes** — `MIN_W`, `MAX_W`, `DEFAULT_W`, `COLLAPSED_W` in `useSidebarStore.ts`.
* **New icon theme** — add an entry to `ICON_THEMES` in `themes.ts` (stroke, tile style, colour mode, glow).

## Not using React?

Your live site (`/app`) is server-rendered/vanilla. Two options: mount this as a small React island
(`createRoot(document.getElementById("sidebar-root")).render(<App />)` and build with Vite), or port the
CSS in `index.css` (the visual language is all there) and the logic in `useSidebarStore.ts` / `GlassSidebar.tsx`.
