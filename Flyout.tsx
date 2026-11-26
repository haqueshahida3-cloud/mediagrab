import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../utils/cn";
import { Icon } from "./icons";
import { ItemIcon } from "./ItemIcon";
import { NAV } from "./navData";
import { useSidebar } from "./context";
import type { ResolvedNavItem } from "./types";

interface Props {
  id: string;
  rect: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
}

/** Collapsed-mode hover card: acts as a tooltip for pages and a sub-menu for groups. */
export function Flyout({ id, rect, onEnter, onLeave }: Props) {
  const { theme, activeId, navigate } = useSidebar();
  const item = NAV.index.get(id);
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(rect.top);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    setTop(Math.max(10, Math.min(rect.top - 2, window.innerHeight - h - 10)));
  }, [rect.top, id]);

  if (!item) return null;
  const isGroup = !!item.children;

  const renderList = (list: ResolvedNavItem[], depth: number) =>
    list.map((c) => {
      const active = activeId === c.id;
      return (
        <div key={c.id}>
          {c.children ? (
            <div
              className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500"
              style={{ paddingLeft: 10 + depth * 12 }}
            >
              {c.label}
            </div>
          ) : (
            <button
              onClick={() => navigate(c.id)}
              className={cn(
                "group/row flex w-full items-center gap-2.5 rounded-xl py-2 pr-2.5 text-left text-[13px] transition-all duration-150 active:scale-[0.97]",
                active ? "bg-white/10 text-white ring-1 ring-white/10" : "text-slate-300 hover:bg-white/[0.07] hover:text-white",
              )}
              style={{ paddingLeft: 10 + depth * 12 }}
            >
              <ItemIcon item={c} theme={theme} active={active} size="sm" />
              <span className="flex-1 truncate">{c.label}</span>
              {c.badge && (
                <span
                  className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  style={{ background: `${c.hue}26`, color: c.hue }}
                >
                  {c.badge}
                </span>
              )}
            </button>
          )}
          {c.children && <div>{renderList(c.children, depth + 1)}</div>}
        </div>
      );
    });

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[90] pl-5"
      style={{ left: rect.right, top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className={cn("glass-pop animate-pop-side relative rounded-2xl p-1.5", isGroup ? "min-w-[210px] max-w-[260px]" : "")}>
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-medium text-white">
          {!isGroup && <ItemIcon item={item} theme={theme} size="sm" className="!h-4 !w-4" />}
          <span className="whitespace-nowrap">{item.label}</span>
          {item.badge && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
              style={{ background: `${item.hue}26`, color: item.hue }}
            >
              {item.badge}
            </span>
          )}
          {isGroup && <Icon name="chevron" size={13} className="ml-auto text-slate-500" />}
        </div>
        {isGroup && (
          <div className="mt-0.5 max-h-[60vh] overflow-y-auto border-t border-white/10 pt-1 thin-scroll">
            {renderList(item.children!, 0)}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
