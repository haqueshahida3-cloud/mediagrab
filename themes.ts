export type IconThemeId = "outline" | "tinted" | "neon" | "gradient";

export interface IconTheme {
  id: IconThemeId;
  name: string;
  description: string;
  stroke: number;
  /** how the 32px icon tile is painted */
  tile: "none" | "tint" | "gradient";
  /** mono = neutral slate/white icons, hue = every item uses its own colour */
  colorMode: "mono" | "hue";
  glow: boolean;
}

export const ICON_THEMES: IconTheme[] = [
  {
    id: "outline",
    name: "Outline",
    description: "Thin, quiet, monochrome",
    stroke: 1.5,
    tile: "none",
    colorMode: "mono",
    glow: false,
  },
  {
    id: "tinted",
    name: "Tinted",
    description: "Soft colour tiles",
    stroke: 1.75,
    tile: "tint",
    colorMode: "hue",
    glow: false,
  },
  {
    id: "neon",
    name: "Neon",
    description: "Glowing coloured strokes",
    stroke: 2,
    tile: "none",
    colorMode: "hue",
    glow: true,
  },
  {
    id: "gradient",
    name: "Gradient",
    description: "Vivid solid tiles",
    stroke: 2,
    tile: "gradient",
    colorMode: "hue",
    glow: false,
  },
];

export const DEFAULT_THEME: IconThemeId = "tinted";

export const getTheme = (id: string): IconTheme => ICON_THEMES.find((t) => t.id === id) ?? ICON_THEMES[1];
