import Link from "next/link";
import type { ReactNode } from "react";

export const PLATFORM_COLORS: Record<string, string> = {
  youtube: "#ef4444",
  facebook: "#3b82f6",
  instagram: "#ec4899",
  x: "#e2e8f0",
  tiktok: "#22d3ee",
  web: "#a78bfa",
};

export function Thumb({ src, alt, className = "" }: { src: string | null; alt: string; className?: string }) {
  if (!src) {
    return <div className={`bg-gradient-to-br from-slate-800 to-slate-900 ${className}`} aria-label={alt} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className={`object-cover ${className}`} />;
}

export function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium capitalize text-slate-300">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: PLATFORM_COLORS[platform] ?? "#94a3b8" }} />
      {platform}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-200">#{children}</span>;
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-400">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-white/10 bg-white/[0.03] ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <Card className="grid place-items-center p-12 text-center text-sm text-slate-400">
      <div>{children}</div>
    </Card>
  );
}

export function EmptyLibrary() {
  return (
    <Empty>
      <p className="mb-2">Your library is empty.</p>
      <Link href="/" className="text-violet-300 underline">
        Add a link or load demo data on the Library page
      </Link>
    </Empty>
  );
}

export const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-500 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-violet-400 disabled:opacity-60";
export const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10";
export const input =
  "w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-violet-400 focus:outline-none";

export function fmtDate(d: Date | null | undefined) {
  if (!d) return "Undated";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
