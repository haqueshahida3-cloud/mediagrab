import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../utils/cn";
import { Icon, type IconName } from "./icons";

export type MenuEntry =
  | {
      type: "item";
      label: string;
      icon?: IconName;
      onClick: () => void;
      danger?: boolean;
      hint?: string;
      checked?: boolean;
      disabled?: boolean;
    }
  | { type: "sep" }
  | { type: "label"; text: string };

interface Props {
  x: number;
  y: number;
  title?: string;
  entries: MenuEntry[];
  onClose: () => void;
}

/** Frosted glass right-click menu. Rendered in a portal so backdrop-filter parents can't clip it. */
export function ContextMenu({ x, y, title, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 10;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
  }, [x, y, entries]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!btns.length) return;
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[next].focus();
      }
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      className="glass-pop animate-pop fixed z-[100] min-w-[220px] max-w-[280px] rounded-2xl p-1.5 text-[13px] text-slate-200"
      style={{ left: pos.left, top: pos.top }}
    >
      {title && (
        <div className="truncate px-2.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-slate-400/80">
          {title}
        </div>
      )}
      {entries.map((e, i) => {
        if (e.type === "sep") return <div key={i} className="mx-2 my-1.5 h-px bg-white/10" />;
        if (e.type === "label")
          return (
            <div key={i} className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wider text-slate-500">
              {e.text}
            </div>
          );
        return (
          <button
            key={i}
            role="menuitem"
            disabled={e.disabled}
            onClick={() => {
              e.onClick();
              onClose();
            }}
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all duration-150 outline-none",
              "hover:bg-white/10 focus-visible:bg-white/10 active:scale-[0.98]",
              "disabled:cursor-not-allowed disabled:opacity-40",
              e.danger ? "text-rose-300 hover:bg-rose-500/15" : "text-slate-200",
            )}
          >
            <span className="flex h-4 w-4 items-center justify-center text-slate-400 transition-transform duration-200 group-hover:scale-110 group-hover:text-white">
              {e.icon && <Icon name={e.icon} size={15} />}
            </span>
            <span className="flex-1 truncate">{e.label}</span>
            {e.checked && <Icon name="check" size={14} className="text-sky-300" stroke={2.25} />}
            {e.hint && <kbd className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">{e.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
