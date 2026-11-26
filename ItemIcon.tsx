import type { CSSProperties } from "react";
import { cn } from "../../utils/cn";
import { Icon } from "./icons";
import type { IconTheme } from "./themes";
import type { ResolvedNavItem } from "./types";

interface Props {
  item: Pick<ResolvedNavItem, "icon" | "hue">;
  theme: IconTheme;
  active?: boolean;
  /** lg = 32px tile (top level), sm = bare 16px icon (nested) */
  size?: "lg" | "sm";
  className?: string;
}

/** Renders a nav icon according to the currently selected icon theme. */
export function ItemIcon({ item, theme, active, size = "lg", className }: Props) {
  const hue = item.hue;
  const lg = size === "lg";

  if (!item.icon) {
    return (
      <span className={cn("flex h-4 w-4 items-center justify-center", className)}>
        <span
          className="h-1.5 w-1.5 rounded-full transition-all duration-300 group-hover/row:scale-150"
          style={{ background: theme.colorMode === "hue" ? hue : "#94a3b8", boxShadow: theme.glow ? `0 0 8px ${hue}` : undefined }}
        />
      </span>
    );
  }

  const gradient = lg && theme.tile === "gradient";
  const color = gradient ? "#fff" : theme.colorMode === "hue" ? hue : active ? "#fff" : "#cbd5e1";

  const tileStyle: CSSProperties = { color };
  if (lg && theme.tile === "tint") {
    tileStyle.background = `${hue}${active ? "33" : "22"}`;
    tileStyle.boxShadow = `inset 0 0 0 1px ${hue}${active ? "55" : "30"}`;
  } else if (gradient) {
    tileStyle.background = `linear-gradient(135deg, ${hue}, color-mix(in oklab, ${hue} 50%, #7c5cff))`;
    tileStyle.boxShadow = `0 6px 16px -6px ${hue}cc, inset 0 1px 0 rgba(255,255,255,.35)`;
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center transition-all duration-300",
        lg ? "h-8 w-8 rounded-[11px]" : "h-4 w-4",
        className,
      )}
      style={tileStyle}
    >
      <Icon
        name={item.icon}
        size={lg ? 18 : 15}
        stroke={theme.stroke}
        className="transition-transform duration-300 ease-out group-hover/row:-rotate-6 group-hover/row:scale-110"
        style={theme.glow ? { filter: `drop-shadow(0 0 5px ${hue}cc)` } : undefined}
      />
    </span>
  );
}
