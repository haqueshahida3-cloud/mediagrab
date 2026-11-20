import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediaGrab — Media Intelligence",
  description:
    "Save media links, explore a visual media map, build creator knowledge profiles, topic collections, relationship graphs, timelines and pick the right 4K wallpaper.",
};

const NAV = [
  { href: "/", label: "Library" },
  { href: "/map", label: "Visual Map" },
  { href: "/graph", label: "Relationships" },
  { href: "/creators", label: "Creators" },
  { href: "/collections", label: "Collections" },
  { href: "/timeline", label: "Timeline" },
  { href: "/wallpapers", label: "4K Wallpapers" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/85 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 text-sm text-slate-950">M</span>
              MediaGrab <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-300">AI</span>
            </Link>
            <nav className="flex flex-wrap gap-1 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-slate-300 transition hover:bg-white/10 hover:text-white">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
