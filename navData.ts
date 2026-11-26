import type { NavItem, ResolvedNavItem } from "./types";

/**
 * Edit this tree to match your own website.
 * - Up to any depth (3 levels shown here)
 * - Items without `children` are pages, items with `children` are expandable groups.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    id: "home",
    label: "Home",
    icon: "home",
    hue: "#60a5fa",
    kind: "home",
    description: "Paste a link and grab videos, photos or MP3 in genuine quality.",
  },
  {
    id: "downloader",
    label: "Downloader",
    icon: "download",
    hue: "#818cf8",
    children: [
      {
        id: "dl-video",
        label: "Video",
        icon: "video",
        children: [
          { id: "dl-youtube", label: "YouTube", icon: "play", hue: "#f87171", kind: "download", description: "Videos, Shorts and playlists in HD, 4K or 8K." },
          { id: "dl-facebook", label: "Facebook", icon: "users", hue: "#60a5fa", kind: "download", description: "Public videos and reels in original quality." },
          { id: "dl-instagram", label: "Instagram", icon: "camera", hue: "#f472b6", kind: "download", description: "Reels, posts, carousels and stories." },
          { id: "dl-x", label: "X / Twitter", icon: "at", hue: "#cbd5e1", kind: "download", description: "Videos and GIFs from any public post." },
          { id: "dl-tiktok", label: "TikTok", icon: "music", hue: "#2dd4bf", kind: "download", description: "Watermark-free TikTok videos." },
        ],
      },
      { id: "dl-photos", label: "Photos & Albums", icon: "image", kind: "download", description: "Original-quality photos, carousels and albums." },
      { id: "dl-mp3", label: "Audio · MP3", icon: "music", kind: "download", badge: "Hot", description: "Extract crisp MP3 audio from any video link." },
      { id: "dl-playlists", label: "Playlists", icon: "list", kind: "download", description: "Queue an entire playlist in one go." },
    ],
  },
  {
    id: "tools",
    label: "Media Tools",
    icon: "wrench",
    hue: "#34d399",
    children: [
      { id: "tool-convert-audio", label: "Video → MP3 / WAV", icon: "music", kind: "tool", description: "Convert video files to MP3, WAV or M4A right in the browser." },
      { id: "tool-image", label: "Image Converter", icon: "image", kind: "tool", description: "JPG · PNG · WebP conversion with quality control." },
      { id: "tool-frame", label: "Frame Grabber", icon: "crop", kind: "tool", description: "Capture any frame of a video as a full-resolution image." },
      { id: "tool-meta", label: "Metadata Viewer", icon: "info", kind: "tool", description: "Inspect codecs, bitrate, EXIF and more." },
    ],
  },
  {
    id: "ai",
    label: "AI Studio",
    icon: "sparkles",
    hue: "#a78bfa",
    badge: "AI",
    children: [
      { id: "ai-summary", label: "Smart Summary", icon: "file", kind: "ai", badge: "New", description: "Get a clean summary and key points of any video." },
      { id: "ai-transcribe", label: "Transcribe", icon: "mic", kind: "ai", description: "Accurate speech-to-text with timestamps." },
      {
        id: "ai-subtitles",
        label: "Subtitles",
        icon: "captions",
        children: [
          { id: "ai-sub-generate", label: "Generate", icon: "wand", kind: "ai", description: "Auto-generate subtitles (SRT / VTT)." },
          { id: "ai-sub-translate", label: "Translate", icon: "globe", kind: "ai", description: "Translate subtitles into 50+ languages." },
        ],
      },
      { id: "ai-thumb", label: "Thumbnail Maker", icon: "wand", kind: "ai", description: "AI-powered thumbnails from your best frames." },
    ],
  },
  {
    id: "library",
    label: "Library",
    icon: "folder",
    hue: "#fbbf24",
    children: [
      { id: "lib-downloads", label: "My Downloads", icon: "download", kind: "library", description: "Everything you have grabbed so far." },
      { id: "lib-collections", label: "Collections", icon: "bookmark", kind: "library", description: "Group your media into collections." },
      { id: "lib-history", label: "History", icon: "clock", kind: "library", description: "A timeline of your recent activity." },
    ],
  },
  { id: "install", label: "Install App", icon: "phone", hue: "#fb923c", kind: "info", description: "Install MediaGrab on your phone or PC and share links straight into it." },
  { id: "settings", label: "Settings", icon: "sliders", hue: "#94a3b8", kind: "info", description: "Preferences for quality, formats and notifications." },
  { id: "help", label: "Help & FAQ", icon: "help", hue: "#22d3ee", kind: "info", description: "Answers to the most frequently asked questions." },
];

function resolve(
  items: NavItem[],
  level: number,
  path: string[],
  inheritedHue: string,
  index: Map<string, ResolvedNavItem>,
): ResolvedNavItem[] {
  return items.map((item) => {
    const hue = item.hue ?? inheritedHue;
    const node: ResolvedNavItem = {
      ...item,
      hue,
      level,
      path,
      parentId: path[path.length - 1],
      children: undefined,
    };
    index.set(node.id, node);
    if (item.children) {
      node.children = resolve(item.children, level + 1, [...path, item.id], hue, index);
    }
    return node;
  });
}

export function buildIndex(items: NavItem[] = NAV_ITEMS) {
  const index = new Map<string, ResolvedNavItem>();
  const tree = resolve(items, 0, [], "#818cf8", index);
  return { tree, index };
}

export const NAV = buildIndex();

/** every group id (items that have children) inside a node — used by expand/collapse all */
export function collectGroupIds(items: ResolvedNavItem[] = NAV.tree): string[] {
  const out: string[] = [];
  const walk = (list: ResolvedNavItem[]) =>
    list.forEach((i) => {
      if (i.children) {
        out.push(i.id);
        walk(i.children);
      }
    });
  walk(items);
  return out;
}
