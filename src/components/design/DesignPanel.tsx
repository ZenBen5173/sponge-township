"use client";
import { Droplets, Footprints, Grid2x2, MousePointer2, Route, Sprout, Trash2, Waves, Wand2 } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Label, Panel, Slider } from "@/components/ui/primitives";
import { getEngine } from "@/lib/engine";
import { FEATURE_INFO, makeRect } from "@/lib/features";
import { EASE } from "@/lib/motion";
import { STORE } from "@/lib/sim/model";
import type { Feature } from "@/lib/sim/types";
import { newId, type Tool, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const TOOLS: { id: Tool; icon: ReactNode; label: string; key: string }[] = [
  { id: "select", icon: <MousePointer2 className="size-4" />, label: "Select", key: "V" },
  { id: "square", icon: <Grid2x2 className="size-4" />, label: "Water square", key: "1" },
  { id: "drain", icon: <Route className="size-4" />, label: "Drain", key: "2" },
  { id: "inlet", icon: <Droplets className="size-4" />, label: "Inlet", key: "3" },
  { id: "permeable", icon: <Footprints className="size-4" />, label: "Permeable", key: "4" },
  { id: "garden", icon: <Sprout className="size-4" />, label: "Rain garden", key: "5" },
];

const HINT: Record<Tool, string> = {
  select: "Click a feature to edit it, drag to move, corners to resize. Del removes.",
  square: "Click open ground to sink a 40 × 30 m court, 1 m deep.",
  drain: "Click points along a street; end on a water square to feed it. Double-click or Enter to finish.",
  inlet: "Click a low spot in a street. Within 25 m of a square it pours straight in.",
  permeable: "Click to lay a 3 × 40 m permeable walk (resize after).",
  garden: "Click to dig a 14 × 6 m rain garden.",
};

export function DesignPanel() {
  const tool = useApp((s) => s.tool);
  const scene = useApp((s) => s.scene);
  const features = useApp((s) => s.features);
  const selectedId = useApp((s) => s.selectedId);
  const showCandidates = useApp((s) => s.showCandidates);
  const active = useApp((s) => s.activeCandidate);
  const set = useApp((s) => s.set);
  const sel = features.find((f) => f.id === selectedId);

  const autoDesign = () => {
    const s = useApp.getState();
    const c = s.scene?.candidates[s.activeCandidate];
    if (!c || !s.scene) return;
    const sq = makeRect("square", c.bx, c.by, s.features, c);
    if (c.courtW && c.courtW < 40) {
      // a tighter site: a smaller, deeper court keeps most of the storage
      sq.w = c.courtW;
      sq.l = c.courtL;
      sq.depth = 1.2;
    }
    const fs: Feature[] = [sq];
    // Gutter drains along the nearest streets, running towards the square from both directions.
    const edge = (p: [number, number]): [number, number] => {
      const cs = Math.cos(sq.rot);
      const sn = Math.sin(sq.rot);
      const px = p[0] - sq.cx;
      const py = p[1] - sq.cy;
      const u = Math.max(-sq.w / 2, Math.min(sq.w / 2, px * cs + py * sn));
      const v = Math.max(-sq.l / 2, Math.min(sq.l / 2, -px * sn + py * cs));
      return [sq.cx + u * cs - v * sn, sq.cy + u * sn + v * cs];
    };
    const roads = s.scene.roads
      .filter((r) => r.kind !== "footway" && r.kind !== "path" && r.kind !== "cycleway")
      .map((r) => {
        let best = { d: Infinity, k: 0, t: 0, p: [0, 0] as [number, number] };
        for (let k = 0; k + 1 < r.pts.length; k++) {
          const [ax, ay] = r.pts[k];
          const [bx, by] = r.pts[k + 1];
          const vx = bx - ax;
          const vy = by - ay;
          const t = Math.max(0, Math.min(1, ((sq.cx - ax) * vx + (sq.cy - ay) * vy) / (vx * vx + vy * vy || 1)));
          const p: [number, number] = [ax + t * vx, ay + t * vy];
          const d = Math.hypot(p[0] - sq.cx, p[1] - sq.cy);
          if (d < best.d) best = { d, k, t, p };
        }
        return { r, ...best };
      })
      .filter((x) => x.d < 110)
      .sort((x, y) => x.d - y.d);
    // prefer streets that flooded in the last run (deepest water along them first)
    const peak = getEngine().basePeak;
    if (peak) {
      const { nx, dx } = s.scene.grid;
      const wet = (r: (typeof roads)[number]) => {
        let m = 0;
        for (const [x, y] of r.r.pts) {
          const c = Math.floor(y / dx) * nx + Math.floor(x / dx);
          if (c >= 0 && c < peak.length) m = Math.max(m, peak[c]);
        }
        return m;
      };
      roads.sort((x, y) => wet(y) - wet(x) + (x.d - y.d) / 400);
    }
    // walk `len` metres along a polyline from (segment k, param t) in direction dir
    const walk = (pts: [number, number][], k: number, t: number, dir: 1 | -1, len: number): [number, number][] => {
      const out: [number, number][] = [];
      let left = len;
      const seg = k;
      let pos: [number, number] = [pts[k][0] + t * (pts[k + 1][0] - pts[k][0]), pts[k][1] + t * (pts[k + 1][1] - pts[k][1])];
      out.push(pos);
      let target = dir > 0 ? seg + 1 : seg;
      while (left > 0 && target >= 0 && target < pts.length) {
        const nxt = pts[target];
        const d = Math.hypot(nxt[0] - pos[0], nxt[1] - pos[1]);
        if (d >= left) {
          out.push([pos[0] + ((nxt[0] - pos[0]) * left) / d, pos[1] + ((nxt[1] - pos[1]) * left) / d]);
          break;
        }
        out.push(nxt);
        left -= d;
        pos = nxt;
        target += dir;
      }
      return out.reverse();
    };
    let nd = 0;
    const used: [number, number][] = [];
    for (const rd of roads) {
      if (nd >= 4) break;
      if (used.some((u) => Math.hypot(u[0] - rd.p[0], u[1] - rd.p[1]) < 25)) continue;
      used.push(rd.p);
      for (const dir of [1, -1] as const) {
        const run = walk(rd.r.pts, rd.k, rd.t, dir, 55);
        if (run.length < 2 || Math.hypot(run[0][0] - run[run.length - 1][0], run[0][1] - run[run.length - 1][1]) < 15) continue;
        fs.push({ id: newId("dr"), kind: "drain", name: `Gutter ${++nd}`, pts: [...run, edge(rd.p)], capacityPerM: 0.006 });
        if (nd >= 4) break;
      }
    }
    const g = makeRect("garden", c.bx + Math.cos(c.rot) * 34, c.by + Math.sin(c.rot) * 34, fs);
    g.rot = c.rot;
    fs.push(g);
    const pw = makeRect("permeable", c.bx - Math.sin(c.rot) * 26, c.by + Math.cos(c.rot) * 26, fs);
    pw.rot = c.rot + Math.PI / 2;
    fs.push(pw);
    s.set({ features: [...s.features, ...fs], selectedId: sq.id, tool: "select", run: { ...s.run, designDirty: true } });
    getEngine().scene3d?.focus(c.bx, c.by, 200);
  };

  return (
    <Panel className="flex max-h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="font-display text-xl font-semibold leading-tight">Make it a sponge</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => set({ tool: t.id, drawing: null })}
            title={`${t.label} (${t.key}) — ${HINT[t.id]}`}
            className={cn(
              "group relative flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[10px] font-medium transition-all duration-150",
              tool === t.id
                ? "-translate-x-px -translate-y-px border-[1.5px] border-foreground bg-foreground text-white shadow-[3px_3px_0_0_var(--primary)]"
                : "border-border bg-card text-muted-foreground hover:-translate-x-px hover:-translate-y-px hover:border-foreground hover:text-foreground hover:shadow-[3px_3px_0_0_var(--foreground)]",
            )}
          >
            <span className={cn("transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-110", tool === t.id && "text-primary")}>{t.icon}</span>
            {t.label}
            <span className="absolute right-1 top-0.5 font-mono text-[8px] opacity-50">{t.key}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1 scroll-thin">
        {sel ? (
          <Inspector f={sel} />
        ) : (
          <>
            <div className="mt-2 flex items-center justify-between">
              <Label tone="ink">Open space found</Label>
              <button onClick={() => set({ showCandidates: !showCandidates })} className="label transition-colors hover:!text-foreground">
                {showCandidates ? "Hide" : "Show"}
              </button>
            </div>
            {!scene?.candidates.length && <div className="mt-2 text-[11px] text-muted-foreground">No open land over 900 m² here.</div>}
            <div className="mt-1.5 space-y-1.5">
              {scene?.candidates.map((c, k) => (
                <motion.button
                  key={c.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: k * 0.05, ease: EASE.expressive, duration: 0.4 }}
                  onClick={() => {
                    set({ activeCandidate: k, showCandidates: true });
                    getEngine().scene3d?.focus(c.bx, c.by, 200);
                  }}
                  className={cn(
                    "group relative w-full rounded-xl border bg-card p-2 text-left transition-all duration-150",
                    k === active ? "-translate-x-px -translate-y-px border-[1.5px] border-foreground shadow-[3px_3px_0_0_var(--primary)]" : "border-border hover:-translate-x-px hover:-translate-y-px hover:shadow-[3px_3px_0_0_var(--foreground)]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
                      <span className={cn("num grid size-5 shrink-0 place-items-center rounded-md text-[10px]", k === active ? "bg-primary text-white" : "bg-muted text-foreground")}>{c.label.replace(/^Site\s*/, "")}</span>
                      <span className="truncate font-normal text-muted-foreground">{c.name ?? c.kind}</span>
                    </span>
                    <span className="num text-[13px] font-bold text-foreground">
                      {c.score}
                      <span className="text-[9px] font-normal text-muted-foreground">/100</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sand">
                    <motion.div className={cn("h-full rounded-full", k === active ? "bg-primary" : "bg-foreground")} initial={{ width: 0 }} animate={{ width: `${c.score}%` }} transition={{ delay: 0.3 + k * 0.05, duration: 0.7 }} />
                  </div>
                  <div className="num mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                    <span>{Math.round(c.area).toLocaleString()} m²</span>
                    <span>{c.relElev >= 0 ? "+" : ""}{c.relElev.toFixed(2)} m vs. area</span>
                    <span>{(c.inflowArea / 10000).toFixed(1)} ha drains here</span>
                    <span>{c.housesNear} homes ≤150 m</span>
                    <span className={c.fits ? "text-ok" : c.courtW ? "text-warn" : "text-danger"}>{c.fits ? "fits 40×30" : c.courtW ? `fits ${c.courtW}×${c.courtL}` : "too tight"}</span>
                  </div>
                  {c.floodedNear !== undefined && (
                    <div className={cn("mt-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium", c.floodedNear > 0 ? "bg-tomato-soft text-tomato-ink" : "bg-mint text-ok")}>
                      <Waves className="size-3" />
                      {c.floodedNear > 0
                        ? `${c.floodedNear} flooded homes ≤150 m · streets to ${Math.round((c.deepestNear ?? 0) * 100)} cm`
                        : "no flooded homes nearby in that storm"}
                    </div>
                  )}
                </motion.button>
              ))}
            </div>
            {!!scene?.candidates.length && (
              <button
                onClick={autoDesign}
                className="group mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-foreground bg-sun-soft px-3 py-2 text-[11px] font-semibold text-foreground transition-all duration-150 hover:-translate-x-px hover:-translate-y-px hover:border-solid hover:bg-sun hover:shadow-[3px_3px_0_0_var(--foreground)]"
              >
                <Wand2 className="size-3.5 transition-transform duration-300 group-hover:-rotate-12 group-hover:scale-110" /> Suggest a layout at {scene.candidates[active]?.label}
              </button>
            )}

            {features.length > 0 && (
              <>
                <Label tone="ink" className="mt-4">Your design</Label>
                <div className="mt-1 space-y-1">
                  {features.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => set({ selectedId: f.id })}
                      className="lift group flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-left text-[11px]"
                      style={{ borderLeft: `4px solid ${FEATURE_INFO[f.kind].color}` }}
                    >
                      <span className="flex-1 truncate font-medium">{f.name}</span>
                      <span className="label !text-[9px] transition-colors group-hover:!text-foreground">{FEATURE_INFO[f.kind].short}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

function Inspector({ f }: { f: Feature }) {
  const update = useApp((s) => s.updateFeature);
  const remove = useApp((s) => s.removeFeature);
  const set = useApp((s) => s.set);
  const info = FEATURE_INFO[f.kind];
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-2 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <input
            value={f.name}
            onChange={(e) => update(f.id, { name: e.target.value })}
            className="-mx-1 w-full rounded-md bg-transparent px-1 font-display text-base font-semibold text-foreground outline-none transition-colors hover:bg-muted focus:bg-sun-soft"
          />
          <div className="mb-1 flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: info.color }} />
            <Label className="!text-[9px]">{info.label}</Label>
          </div>
          <div className="text-[10px] leading-snug text-muted-foreground">{info.blurb}</div>
        </div>
        <button onClick={() => remove(f.id)} title="Delete (Del)" className="lift rounded-lg border border-border bg-card p-1.5 text-muted-foreground hover:border-foreground hover:text-danger">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {(f.kind === "square" || f.kind === "garden" || f.kind === "permeable") && (
        <>
          <Slider label="Width" value={f.w} min={f.kind === "permeable" ? 1.5 : 2} max={f.kind === "square" ? 120 : f.kind === "garden" ? 60 : 200} step={0.5} onChange={(v) => update(f.id, { w: v })} format={(v) => `${v} m`} />
          <Slider label="Length" value={f.l} min={2} max={f.kind === "square" ? 120 : f.kind === "garden" ? 60 : 200} step={0.5} onChange={(v) => update(f.id, { l: v })} format={(v) => `${v} m`} />
          <Slider label="Rotation" value={Math.round(((f.rot * 180) / Math.PI + 360) % 180)} min={0} max={179} onChange={(v) => update(f.id, { rot: (v * Math.PI) / 180 })} format={(v) => `${v}°`} />
          {f.kind === "square" && (
            <>
              <Slider label="Depth" value={f.depth} min={0.3} max={2} step={0.05} onChange={(v) => update(f.id, { depth: v })} format={(v) => `${v.toFixed(2)} m`} />
              <Slider
                label="Outlet pipe"
                value={Math.round((f.outletD ?? 0.2) * 1000)}
                min={75}
                max={400}
                step={25}
                onChange={(v) => update(f.id, { outletD: v / 1000 })}
                format={(v) => `Ø ${v} mm`}
                hint="Smaller pipe = holds water longer, empties slower."
              />
              <div className="grid grid-cols-2 gap-2 rounded-xl border-[1.5px] border-foreground bg-water-soft/60 p-2.5 shadow-[2px_2px_0_0_var(--water)]">
                <div>
                  <Label>Storage</Label>
                  <div className="num text-lg font-bold text-water-deep">{Math.round(f.w * f.l * f.depth).toLocaleString()} m³</div>
                </div>
                <div>
                  <Label>Like</Label>
                  <div className="text-[11px] leading-tight text-foreground">
                    {f.w * f.l * f.depth > 1500 ? "Benthemplein, Rotterdam (≈1,700 m³)" : "South Jamaica Houses, NYC (≈1,250 m³)"}
                  </div>
                </div>
              </div>
            </>
          )}
          {f.kind === "garden" && (
            <>
              <Slider label="Ponding depth" value={f.depth} min={0.1} max={0.5} step={0.05} onChange={(v) => update(f.id, { depth: v })} format={(v) => `${(v * 100).toFixed(0)} cm`} />
              <div className="text-[10px] text-muted-foreground">
                Holds about <span className="num text-foreground">{Math.round(f.w * f.l * (f.depth + STORE.garden.sMax))} m³</span>: {Math.round(f.depth * 100)} cm on top plus{" "}
                {Math.round(STORE.garden.sMax * 1000)} mm in the soil and gravel.
              </div>
            </>
          )}
          {f.kind === "permeable" && (
            <div className="text-[10px] text-muted-foreground">
              Soaks up to 300 mm/h into a 300 mm stone bed (≈{Math.round(f.w * f.l * STORE.permeable.sMax)} m³), which seeps into the clay at 2 mm/h.
            </div>
          )}
        </>
      )}
      {f.kind === "drain" && (
        <Slider
          label="Capture per metre"
          value={Math.round(f.capacityPerM * 1000)}
          min={2}
          max={20}
          onChange={(v) => update(f.id, { capacityPerM: v / 1000 })}
          format={(v) => `${v} L/s/m`}
          hint={`Total ≈ ${Math.round(f.capacityPerM * 1000 * f.pts.slice(1).reduce((a, p, k) => a + Math.hypot(p[0] - f.pts[k][0], p[1] - f.pts[k][1]), 0))} L/s`}

        />
      )}
      {f.kind === "inlet" && <Slider label="Capacity" value={Math.round(f.capacity * 1000)} min={20} max={300} step={10} onChange={(v) => update(f.id, { capacity: v / 1000 })} format={(v) => `${v} L/s`} />}
      <button onClick={() => set({ selectedId: null })} className="lift w-full rounded-lg border-[1.5px] border-foreground bg-card py-1.5 text-[11px] font-semibold text-foreground">

        Done
      </button>
    </motion.div>
  );
}
