import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../utils/cn";
import { Icon } from "./icons";
import { ItemIcon } from "./ItemIcon";
import { ICON_THEMES } from "./themes";
import { COLLAPSED_W, MAX_W, MIN_W, type SidebarStore } from "./useSidebarStore";

const SAMPLE = [
  { icon: "home", hue: "#60a5fa" },
  { icon: "sparkles", hue: "#a78bfa" },
  { icon: "folder", hue: "#fbbf24" },
  { icon: "download", hue: "#34d399" },
] as const;

interface Props {
  anchor: DOMRect;
  store: SidebarStore;
  onClose: () => void;
  toast: (m: string) => void;
}

/** Appearance popover: icon themes, width slider and reset. */
export function SettingsPopover({ anchor, store, onClose, toast }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.right + 12, top: anchor.top });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(anchor.right + 12, window.innerWidth - r.width - 12);
    const top = Math.max(12, Math.min(anchor.bottom - r.height, window.innerHeight - r.height - 12));
    setPos({ left: Math.max(12, left), top });
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-settings-btn]"))
        onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="glass-pop animate-pop fixed z-[100] w-[300px] max-w-[calc(100vw-24px)] rounded-3xl p-4 text-slate-200"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-white">
          <Icon name="palette" size={16} className="text-violet-300" />
          Appearance
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-white/10 hover:text-white active:scale-90"
          aria-label="Close"
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500">Icon theme</div>
      <div className="grid grid-cols-2 gap-2">
        {ICON_THEMES.map((t) => {
          const on = store.themeId === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                store.setThemeId(t.id);
                toast(`Icon theme: ${t.name}`);
              }}
              className={cn(
                "group relative rounded-2xl p-2.5 text-left ring-1 transition-all duration-200 active:scale-95",
                on
                  ? "bg-white/10 ring-sky-300/60 shadow-[0_0_24px_-6px_rgba(125,160,255,.7)]"
                  : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.07] hover:ring-white/20",
              )}
            >
              <div className="mb-2 flex gap-1">
                {SAMPLE.map((s) => (
                  <ItemIcon key={s.icon} item={s} theme={t} size="lg" className="!h-6 !w-6 !rounded-lg" />
                ))}
              </div>
              <div className="text-[12.5px] font-medium text-white">{t.name}</div>
              <div className="text-[10.5px] leading-tight text-slate-400">{t.description}</div>
              {on && (
                <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-sky-400 text-slate-900">
                  <Icon name="check" size={10} stroke={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-1 mt-4 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <span>Sidebar width</span>
        <span className="font-mono normal-case tracking-normal text-slate-400">
          {store.collapsed ? `${COLLAPSED_W}px · collapsed` : `${store.width}px`}
        </span>
      </div>
      <input
        type="range"
        min={MIN_W}
        max={MAX_W}
        step={4}
        value={store.width}
        disabled={store.collapsed}
        onChange={(e) => store.setWidth(Number(e.target.value))}
        className="glass-range w-full disabled:opacity-40"
      />

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => {
            store.reset();
            toast("Sidebar reset to defaults");
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] py-2 text-[12.5px] ring-1 ring-white/10 transition-all hover:bg-white/10 active:scale-95"
        >
          <Icon name="reset" size={14} /> Reset layout
        </button>
        <button
          onClick={store.toggleCollapsed}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] py-2 text-[12.5px] ring-1 ring-white/10 transition-all hover:bg-white/10 active:scale-95"
        >
          <Icon name="panel" size={14} /> {store.collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
      <p className="mt-3 text-center text-[11px] text-slate-500">
        <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-slate-300">Ctrl</kbd> +{" "}
        <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-slate-300">B</kbd> toggles the sidebar
      </p>
    </div>,
    document.body,
  );
}
