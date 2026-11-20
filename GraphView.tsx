"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

export type GNode = {
  id: string;
  kind: "media" | "creator" | "topic";
  label: string;
  thumb?: string | null;
  href?: string;
  sub?: string;
  color?: string;
};
export type GEdge = { source: string; target: string; weight: number; kind: string; label?: string };

const W = 1000;
const H = 640;

const EDGE_COLORS: Record<string, string> = {
  same_creator: "#38bdf8",
  shared_topic: "#a78bfa",
  same_period: "#34d399",
  manual: "#fbbf24",
  made_by: "#64748b",
  about: "#475569",
};

const EDGE_NAMES: Record<string, string> = {
  same_creator: "Same creator",
  shared_topic: "Shared topic",
  same_period: "Same period",
  manual: "Manual link",
  made_by: "Made by",
  about: "About topic",
};

type Sim = { id: string; x: number; y: number; vx: number; vy: number; fixed: boolean };

const radius = (k: GNode["kind"]) => (k === "creator" ? 26 : k === "media" ? 21 : 13);

function seed(i: number) {
  const a = i * 2.399963;
  const r = 34 * Math.sqrt(i + 1);
  return {
    x: Math.round((W / 2 + r * Math.cos(a)) * 100) / 100,
    y: Math.round((H / 2 + r * Math.sin(a)) * 100) / 100,
  };
}

export default function GraphView({
  nodes,
  edges,
  height = 640,
  showKindToggles = false,
}: {
  nodes: GNode[];
  edges: GEdge[];
  height?: number;
  showKindToggles?: boolean;
}) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const visNodes = useMemo(() => nodes.filter((n) => !hidden[n.kind]), [nodes, hidden]);
  const visIds = useMemo(() => new Set(visNodes.map((n) => n.id)), [visNodes]);
  const visEdges = useMemo(() => edges.filter((e) => visIds.has(e.source) && visIds.has(e.target)), [edges, visIds]);

  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>(() =>
    Object.fromEntries(nodes.map((n, i) => [n.id, seed(i)])),
  );
  const sim = useRef<Map<string, Sim>>(new Map());
  const alpha = useRef(1);
  const raf = useRef<number | null>(null);
  const edgesRef = useRef(visEdges);
  const nodesRef = useRef(visNodes);

  const startLoop = useRef<() => void>(() => {});

  useEffect(() => {
    edgesRef.current = visEdges;
    nodesRef.current = visNodes;
    const next = new Map<string, Sim>();
    visNodes.forEach((n, i) => {
      const old = sim.current.get(n.id);
      if (old) next.set(n.id, old);
      else {
        const s = seed(i);
        next.set(n.id, { id: n.id, x: s.x, y: s.y, vx: 0, vy: 0, fixed: false });
      }
    });
    sim.current = next;
    alpha.current = 1;

    const tick = () => {
      const arr = [...sim.current.values()];
      const a = alpha.current;
      const byId = sim.current;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const p = arr[i];
          const q = arr[j];
          let dx = p.x - q.x;
          let dy = p.y - q.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          const f = Math.min(3000 / d2, 8) * a;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          p.vx += fx;
          p.vy += fy;
          q.vx -= fx;
          q.vy -= fy;
        }
      }
      for (const e of edgesRef.current) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = e.kind === "made_by" ? 90 : e.kind === "about" ? 100 : 150 - e.weight * 50;
        const f = (d - rest) * 0.02 * a * (0.6 + e.weight * 0.6);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
      }
      for (const p of arr) {
        p.vx += (W / 2 - p.x) * 0.004 * a;
        p.vy += (H / 2 - p.y) * 0.004 * a;
        if (!p.fixed) {
          p.vx *= 0.82;
          p.vy *= 0.82;
          p.x = Math.max(30, Math.min(W - 30, p.x + p.vx));
          p.y = Math.max(30, Math.min(H - 30, p.y + p.vy));
        } else {
          p.vx = 0;
          p.vy = 0;
        }
      }
      alpha.current *= 0.985;
      setPos(Object.fromEntries(arr.map((p) => [p.id, { x: p.x, y: p.y }])));
      if (alpha.current > 0.02) raf.current = requestAnimationFrame(tick);
      else raf.current = null;
    };
    startLoop.current = () => {
      if (raf.current == null) raf.current = requestAnimationFrame(tick);
    };
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [visNodes, visEdges]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of visEdges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [visEdges]);

  const focus = hover ?? selected;
  const isDim = (id: string) => !!focus && id !== focus && !neighbors.get(focus)?.has(id);

  /* ---------- interactions ---------- */
  const drag = useRef<{ type: "node" | "pan"; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  function toWorld(clientX: number, clientY: number) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k, rx: p.x, ry: p.y };
  }

  function onPointerDownNode(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { type: "node", id, sx: w.rx, sy: w.ry, ox: 0, oy: 0, moved: false };
    const s = sim.current.get(id);
    if (s) s.fixed = true;
  }
  function onPointerDownBg(e: React.PointerEvent) {
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { type: "pan", sx: w.rx, sy: w.ry, ox: view.x, oy: view.y, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const w = toWorld(e.clientX, e.clientY);
    if (Math.abs(w.rx - d.sx) + Math.abs(w.ry - d.sy) > 4) d.moved = true;
    if (d.type === "node" && d.id) {
      const s = sim.current.get(d.id);
      if (s && d.moved) {
        s.x = w.x;
        s.y = w.y;
        alpha.current = Math.max(alpha.current, 0.3);
        startLoop.current();
        setPos((p) => ({ ...p, [d.id as string]: { x: w.x, y: w.y } }));
      }
    } else if (d.type === "pan") {
      setView((v) => ({ ...v, x: d.ox + (w.rx - d.sx), y: d.oy + (w.ry - d.sy) }));
    }
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === "node" && d.id) {
      const s = sim.current.get(d.id);
      if (s) s.fixed = false;
      if (!d.moved) setSelected((cur) => (cur === d.id ? null : (d.id as string)));
      else {
        alpha.current = Math.max(alpha.current, 0.2);
        startLoop.current();
      }
    } else if (d.type === "pan" && !d.moved) setSelected(null);
  }
  function zoom(f: number) {
    setView((v) => {
      const k = Math.max(0.4, Math.min(3, v.k * f));
      const cx = W / 2;
      const cy = H / 2;
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
    });
  }

  const sel = selected ? nodes.find((n) => n.id === selected) : null;
  const selEdges = selected ? visEdges.filter((e) => e.source === selected || e.target === selected) : [];
  const kinds = [...new Set(nodes.map((n) => n.kind))];
  const usedEdgeKinds = [...new Set(visEdges.map((e) => e.kind))];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-900/60">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full touch-none select-none"
          style={{ height }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            {visNodes
              .filter((n) => n.kind === "media")
              .map((n) => (
                <clipPath key={n.id} id={`clip-${n.id}`}>
                  <circle cx={0} cy={0} r={radius("media") - 2} />
                </clipPath>
              ))}
          </defs>
          <rect width={W} height={H} fill="transparent" onPointerDown={onPointerDownBg} className="cursor-grab" />
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {visEdges.map((e, i) => {
              const a = pos[e.source];
              const b = pos[e.target];
              if (!a || !b) return null;
              const active = focus && (e.source === focus || e.target === focus);
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={EDGE_COLORS[e.kind] ?? "#64748b"}
                  strokeWidth={active ? 2.5 : 1 + e.weight * 1.5}
                  strokeOpacity={focus ? (active ? 0.95 : 0.07) : 0.5}
                  strokeDasharray={e.kind === "about" ? "3 4" : undefined}
                />
              );
            })}
            {visNodes.map((n) => {
              const p = pos[n.id];
              if (!p) return null;
              const r = radius(n.kind);
              const dim = isDim(n.id);
              const isSel = n.id === selected;
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x} ${p.y})`}
                  opacity={dim ? 0.18 : 1}
                  className="cursor-pointer"
                  onPointerDown={(e) => onPointerDownNode(e, n.id)}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  {n.kind === "media" && (
                    <>
                      <circle r={r + 2} fill={n.color ?? "#8b5cf6"} opacity={isSel ? 1 : 0.85} />
                      <circle r={r - 2} fill="#0f172a" />
                      {n.thumb && (
                        <image
                          href={n.thumb}
                          x={-r}
                          y={-r}
                          width={r * 2}
                          height={r * 2}
                          preserveAspectRatio="xMidYMid slice"
                          clipPath={`url(#clip-${n.id})`}
                        />
                      )}
                    </>
                  )}
                  {n.kind === "creator" && (
                    <>
                      <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={9} fill="#0e7490" stroke={isSel ? "#fff" : "#22d3ee"} strokeWidth={isSel ? 3 : 2} />
                      <text textAnchor="middle" dy="0.35em" fontSize="15" fontWeight="700" fill="#ecfeff">
                        {n.label.slice(0, 2).toUpperCase()}
                      </text>
                    </>
                  )}
                  {n.kind === "topic" && <circle r={r} fill="#312e81" stroke={isSel ? "#fff" : "#818cf8"} strokeWidth={isSel ? 3 : 1.5} />}
                  {n.kind === "topic" && (
                    <text textAnchor="middle" dy="0.35em" fontSize="11" fill="#c7d2fe">
                      #
                    </text>
                  )}
                  <text y={r + 13} textAnchor="middle" fontSize="11" fill="#e2e8f0" stroke="#020617" strokeWidth="3" paintOrder="stroke">
                    {n.label.length > 24 ? `${n.label.slice(0, 22)}…` : n.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        <div className="absolute right-3 top-3 flex flex-col gap-1">
          {[
            ["+", 1.25],
            ["−", 0.8],
          ].map(([l, f]) => (
            <button key={l as string} onClick={() => zoom(f as number)} className="h-8 w-8 rounded-lg border border-white/15 bg-slate-900/90 text-lg leading-none hover:bg-slate-800">
              {l}
            </button>
          ))}
          <button
            onClick={() => {
              setView({ k: 1, x: 0, y: 0 });
              alpha.current = 1;
              startLoop.current();
            }}
            className="h-8 w-8 rounded-lg border border-white/15 bg-slate-900/90 text-xs hover:bg-slate-800"
            title="Reset"
          >
            ⟲
          </button>
        </div>

        <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-slate-950/80 px-3 py-2 text-[11px] text-slate-300">
          {usedEdgeKinds.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ background: EDGE_COLORS[k] ?? "#64748b" }} />
              {EDGE_NAMES[k] ?? k}
            </span>
          ))}
        </div>
      </div>

      <aside className="space-y-4">
        {showKindToggles && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Show</div>
            {kinds.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 py-0.5 capitalize">
                <input type="checkbox" checked={!hidden[k]} onChange={() => setHidden((h) => ({ ...h, [k]: !h[k] }))} />
                {k === "media" ? "Media" : k === "creator" ? "Creators" : "Topics"}
                <span className="ml-auto text-xs text-slate-500">{nodes.filter((n) => n.kind === k).length}</span>
              </label>
            ))}
          </div>
        )}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm">
          {sel ? (
            <div className="space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">{sel.kind}</div>
                <div className="font-semibold leading-snug">{sel.label}</div>
                {sel.sub && <div className="text-xs text-slate-400">{sel.sub}</div>}
              </div>
              {sel.href && (
                <Link href={sel.href} className="inline-block rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-semibold hover:bg-violet-400">
                  Open details →
                </Link>
              )}
              <div>
                <div className="mb-1 text-xs font-semibold text-slate-400">Connections ({selEdges.length})</div>
                <ul className="max-h-64 space-y-1.5 overflow-auto pr-1">
                  {selEdges.map((e, i) => {
                    const other = nodes.find((n) => n.id === (e.source === selected ? e.target : e.source));
                    return (
                      <li key={i}>
                        <button onClick={() => other && setSelected(other.id)} className="w-full rounded-md bg-white/5 px-2 py-1.5 text-left text-xs hover:bg-white/10">
                          <div className="truncate font-medium">{other?.label}</div>
                          <div className="truncate text-[11px] text-slate-400">
                            {EDGE_NAMES[e.kind] ?? e.kind}
                            {e.label ? ` — ${e.label}` : ""}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                  {selEdges.length === 0 && <li className="text-xs text-slate-500">No connections yet.</li>}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Click a node to inspect it. Drag nodes to rearrange, drag the background to pan, and hover to highlight neighbors.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
