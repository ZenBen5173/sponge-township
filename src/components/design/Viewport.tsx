"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useReducer, useRef, useState } from "react";
import { MathCurveLoader } from "@/components/ui/math-curve-loader";
import { getEngine } from "@/lib/engine";
import { FEATURE_INFO, hitFeature, inRect, makeRect, moveFeature, rectCorners } from "@/lib/features";
import { newId, useApp } from "@/lib/store";
import type { RectFeature } from "@/lib/sim/types";
import { cn } from "@/lib/utils";

/** The 3D view plus everything drawn over it: labels, handles, the split divider and the drain being drawn. */
export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const sky = useRef<HTMLDivElement>(null);
  const [, frame] = useReducer((n: number) => (n + 1) % 1e9, 0);
  const scene = useApp((s) => s.scene);
  const status = useApp((s) => s.sceneStatus);
  const loadLabel = useApp((s) => s.loadLabel);
  const loadProgress = useApp((s) => s.loadProgress);
  const sceneError = useApp((s) => s.sceneError);
  const tool = useApp((s) => s.tool);
  const features = useApp((s) => s.features);
  const selectedId = useApp((s) => s.selectedId);
  const drawing = useApp((s) => s.drawing);
  const view = useApp((s) => s.view);
  const split = useApp((s) => s.split);
  const showCandidates = useApp((s) => s.showCandidates);
  const activeCandidate = useApp((s) => s.activeCandidate);
  const runStatus = useApp((s) => s.run.status);
  const shade = useApp((s) => s.shade);
  const [hoverPt, setHoverPt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const eng = getEngine();
    eng.attach(el);
    const r = eng.scene3d!;
    let last = 0;
    r.onFrame = () => {
      const now = performance.now();
      if (now - last > 33) {
        last = now;
        frame();
      }
    };
    r.onWeather = (st) => {
      if (sky.current) sky.current.style.setProperty("--storm", st.toFixed(3));
    };
    return () => {
      r.onFrame = undefined;
      eng.detach();
    };
  }, []);

  // keyboard: delete, escape, enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const s = useApp.getState();
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) s.removeFeature(s.selectedId);
      if (e.key === "Escape") s.set({ drawing: null, tool: "select", selectedId: null });
      if (e.key === "Enter" && s.drawing) finishDrain();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const r = getEngine().scene3d;
  const ptr = useRef<{ x: number; y: number; at: { x: number; y: number } | null; drag: null | { kind: "move" | "corner" | "rotate"; id: string; last: { x: number; y: number }; corner?: number } } | null>(null);

  function finishDrain() {
    const s = useApp.getState();
    const pts = s.drawing;
    if (pts && pts.length >= 2) {
      const n = s.features.filter((f) => f.kind === "drain").length + 1;
      s.addFeature({ id: newId("dr"), kind: "drain", name: `Drain ${n}`, pts, capacityPerM: 0.006 });
    }
    s.set({ drawing: null, tool: "select" });
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!r || e.button !== 0) return;
    const at = r.pick(e.clientX, e.clientY);
    ptr.current = { x: e.clientX, y: e.clientY, at, drag: null };
    const s = useApp.getState();
    if (s.tool === "select" && at) {
      const sel = s.features.find((f) => f.id === s.selectedId);
      const hit = sel && hitFeature([sel], at.x, at.y, 4) ? sel : hitFeature(s.features, at.x, at.y);
      if (hit) {
        s.set({ selectedId: hit.id });
        ptr.current.drag = { kind: "move", id: hit.id, last: at };
        r.controls.enabled = false;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!r) return;
    const p = ptr.current;
    if (p?.drag) {
      const at = r.pick(e.clientX, e.clientY);
      if (!at) return;
      const s = useApp.getState();
      const f = s.features.find((x) => x.id === p.drag!.id);
      if (!f) return;
      if (p.drag.kind === "move") {
        s.updateFeature(f.id, moveFeature(f, at.x - p.drag.last.x, at.y - p.drag.last.y));
      } else if (p.drag.kind === "corner" && "w" in f) {
        const c = Math.cos(f.rot);
        const sn = Math.sin(f.rot);
        const px = at.x - f.cx;
        const py = at.y - f.cy;
        const u = Math.abs(px * c + py * sn);
        const v = Math.abs(-px * sn + py * c);
        const lim = f.kind === "square" ? [10, 120] : f.kind === "garden" ? [2, 60] : [1.5, 200];
        s.updateFeature(f.id, { w: Math.round(Math.min(lim[1], Math.max(lim[0], 2 * u))), l: Math.round(Math.min(lim[1], Math.max(lim[0], 2 * v))) });
      } else if (p.drag.kind === "rotate" && "w" in f) {
        const ang = Math.atan2(at.y - f.cy, at.x - f.cx) + Math.PI / 2;
        const snap = Math.round(ang / (Math.PI / 36)) * (Math.PI / 36);
        s.updateFeature(f.id, { rot: snap });
      }
      p.drag.last = at;
      return;
    }
    if (tool !== "select") setHoverPt(r.pick(e.clientX, e.clientY));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!r) return;
    const p = ptr.current;
    ptr.current = null;
    r.controls.enabled = true;
    if (!p || p.drag) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return; // it was an orbit drag
    const at = p.at;
    const s = useApp.getState();
    if (!at) return;
    if (s.tool === "square" || s.tool === "garden" || s.tool === "permeable") {
      const cand = s.scene?.candidates.find((c) => {
        const { nx, dx } = s.scene!.grid;
        const i = Math.floor(at.x / dx);
        const j = Math.floor(at.y / dx);
        return c.cells.includes(j * nx + i);
      });
      const f = makeRect(s.tool, at.x, at.y, s.features, cand);
      s.addFeature(f);
      s.set({ tool: "select" });
    } else if (s.tool === "inlet") {
      const n = s.features.filter((f) => f.kind === "inlet").length + 1;
      s.addFeature({ id: newId("in"), kind: "inlet", name: `Inlet ${n}`, x: at.x, y: at.y, capacity: 0.08 });
      s.set({ tool: "select" });
    } else if (s.tool === "drain") {
      const pts = s.drawing ?? [];
      const lastPt = pts[pts.length - 1];
      if (lastPt && Math.hypot(lastPt[0] - at.x, lastPt[1] - at.y) < 2) finishDrain();
      else s.set({ drawing: [...pts, [at.x, at.y]] });
    } else if (s.tool === "select") {
      const hit = hitFeature(s.features, at.x, at.y);
      s.set({ selectedId: hit?.id ?? null });
      if (!hit && s.scene) {
        const { nx, dx } = s.scene.grid;
        const c = Math.floor(at.y / dx) * nx + Math.floor(at.x / dx);
        const k = s.scene.candidateMask[c];
        if (k > 0 && s.showCandidates) s.set({ activeCandidate: k - 1 });
      }
    }
  };

  const startHandle = (e: React.PointerEvent, kind: "corner" | "rotate", id: string, corner?: number) => {
    e.stopPropagation();
    if (!r) return;
    r.controls.enabled = false;
    const at = r.pick(e.clientX, e.clientY) ?? { x: 0, y: 0 };
    ptr.current = { x: e.clientX, y: e.clientY, at, drag: { kind, id, last: at, corner } };
    host.current?.setPointerCapture?.(e.pointerId);
  };

  const sel = features.find((f) => f.id === selectedId);
  const proj = (x: number, y: number, lift = 0) => r?.project(x, y, lift) ?? { x: -999, y: -999, visible: false };
  const cursor = tool === "select" ? (ptr.current?.drag ? "grabbing" : "default") : "crosshair";
  const preview = hoverPt && (tool === "square" || tool === "garden" || tool === "permeable") ? makeRect(tool, hoverPt.x, hoverPt.y, []) : null;

  return (
    <div className="absolute inset-0">
      <div
        ref={sky}
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklab, #1d3347 calc((1 - var(--storm, 0)) * 100%), #0c1218) 0%, color-mix(in oklab, #7f9bb0 calc((1 - var(--storm, 0)) * 100%), #2d3a44) 62%, color-mix(in oklab, #b8c6cf calc((1 - var(--storm, 0)) * 100%), #3a4650) 100%)",
        }}
      />
      <div
        ref={host}
        className="absolute inset-0"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => useApp.getState().drawing && finishDrain()}
        onPointerLeave={() => setHoverPt(null)}
      />

      {/* overlay */}
      {r && scene && status === "ready" && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {showCandidates &&
            runStatus === "idle" &&
            scene.candidates.map((c, k) => {
              const p = proj(c.bx, c.by, 6);
              if (!p.visible) return null;
              const active = k === activeCandidate;
              return (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + k * 0.06 }}
                  className="absolute"
                  style={{ left: p.x, top: p.y, transform: "translate(-50%, -100%)" }}
                >
                  <div
                    className={cn(
                      "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium backdrop-blur",
                      active ? "border-primary/70 bg-primary/25 text-primary" : "border-white/20 bg-black/45 text-white/85",
                    )}
                  >
                    <span className="relative flex size-1.5">
                      <span className="absolute inset-0 rounded-full bg-current" style={{ animation: "ping-soft 1.8s ease-out infinite" }} />
                      <span className="relative size-1.5 rounded-full bg-current" />
                    </span>
                    {c.label} · {(c.area / 1000).toFixed(1)}k m²
                  </div>
                </motion.div>
              );
            })}

          {features.map((f) => {
            const at = f.kind === "drain" ? f.pts[0] : f.kind === "inlet" ? [f.x, f.y] : [f.cx, f.cy];
            const p = proj(at[0], at[1], f.kind === "square" ? 3 : 2);
            if (!p.visible) return null;
            const info = FEATURE_INFO[f.kind];
            if (view === "without") return null;
            if (view === "split" && p.x < (host.current?.clientWidth ?? 0) * split) return null;
            return (
              <div key={f.id} className="absolute" style={{ left: p.x, top: p.y, transform: "translate(-50%, -130%)" }}>
                <div
                  className={cn("whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] backdrop-blur", f.id === selectedId ? "border-sky-300/80 bg-sky-400/25 text-white" : "border-white/15 bg-black/50 text-white/80")}
                  style={{ boxShadow: `inset 2px 0 0 ${info.color}` }}
                >
                  {f.name}
                </div>
              </div>
            );
          })}

          {/* drain being drawn */}
          {drawing && (
            <svg className="absolute inset-0 h-full w-full">
              <polyline
                points={[...drawing, ...(hoverPt ? [[hoverPt.x, hoverPt.y] as [number, number]] : [])]
                  .map(([x, y]) => {
                    const p = proj(x, y, 0.3);
                    return `${p.x},${p.y}`;
                  })
                  .join(" ")}
                fill="none"
                stroke="#5eead4"
                strokeWidth={3}
                strokeDasharray="6 5"
              />
              {drawing.map(([x, y], k) => {
                const p = proj(x, y, 0.3);
                return <circle key={k} cx={p.x} cy={p.y} r={4} fill="#04201c" stroke="#5eead4" strokeWidth={2} />;
              })}
            </svg>
          )}

          {/* placement preview */}
          {preview && (
            <svg className="absolute inset-0 h-full w-full">
              <polygon
                points={rectCorners(preview)
                  .map(([x, y]) => {
                    const p = proj(x, y, 0.3);
                    return `${p.x},${p.y}`;
                  })
                  .join(" ")}
                fill={`${FEATURE_INFO[preview.kind].color}22`}
                stroke={FEATURE_INFO[preview.kind].color}
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
            </svg>
          )}

          {/* handles for the selected rectangle */}
          {sel && "w" in sel && view !== "without" && <RectHandles f={sel} proj={proj} onStart={startHandle} />}

          {/* split divider */}
          {view === "split" && <SplitDivider split={split} />}

          <Legend view={view} shade={shade} />
        </div>
      )}

      <AnimatePresence>
        {status === "loading" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4 text-center">
              <MathCurveLoader curve="hypotrochoid" size={72} speed={2.4} className="text-primary" label="Building the scene" />
              <div>
                <div className="font-display text-2xl text-foreground">Building the town</div>
                <div className="mt-1 text-xs text-muted-foreground">{loadLabel}</div>
              </div>
              <div className="h-1 w-56 overflow-hidden rounded-full bg-white/10">
                <motion.div className="h-full rounded-full bg-primary" animate={{ width: `${Math.round(loadProgress * 100)}%` }} />
              </div>
            </div>
          </motion.div>
        )}
        {status === "error" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 grid place-items-center bg-background/85">
            <div className="max-w-sm text-center">
              <div className="font-display text-2xl">Couldn&apos;t build this area</div>
              <p className="mt-2 text-xs text-muted-foreground">{sceneError}</p>
              <button onClick={() => useApp.getState().set({ phase: "pick" })} className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs hover:border-primary/60">
                Back to the map
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RectHandles({
  f,
  proj,
  onStart,
}: {
  f: RectFeature;
  proj: (x: number, y: number, lift?: number) => { x: number; y: number; visible: boolean };
  onStart: (e: React.PointerEvent, kind: "corner" | "rotate", id: string, corner?: number) => void;
}) {
  const corners = rectCorners(f);
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const knob: [number, number] = [f.cx + (f.l / 2 + 6) * s, f.cy - (f.l / 2 + 6) * c];
  const top: [number, number] = [f.cx + (f.l / 2) * s, f.cy - (f.l / 2) * c];
  const pk = proj(...knob, 1);
  const pt = proj(...top, 1);
  return (
    <>
      <svg className="absolute inset-0 h-full w-full">
        <line x1={pt.x} y1={pt.y} x2={pk.x} y2={pk.y} stroke="#7dd3fc" strokeWidth={1.5} />
      </svg>
      {corners.map(([x, y], k) => {
        const p = proj(x, y, 1);
        return (
          <div
            key={k}
            onPointerDown={(e) => onStart(e, "corner", f.id, k)}
            className="pointer-events-auto absolute size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-[4px] border-2 border-sky-300 bg-[#04131c] shadow-[0_0_0_4px_rgba(125,211,252,0.15)] transition-transform hover:scale-125"
            style={{ left: p.x, top: p.y }}
            title="Drag to resize"
          />
        );
      })}
      <div
        onPointerDown={(e) => onStart(e, "rotate", f.id)}
        className="pointer-events-auto absolute size-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-sky-300 bg-sky-400/30 transition-transform hover:scale-125"
        style={{ left: pk.x, top: pk.y }}
        title="Drag to rotate"
      />
      <div className="absolute rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-sky-100 num" style={{ left: pk.x + 12, top: pk.y - 8 }}>
        {f.w} × {f.l} m{f.kind === "square" ? ` · ${(f.w * f.l * f.depth).toFixed(0)} m³` : ""}
      </div>
      {!inRect(f, f.cx, f.cy) && null}
    </>
  );
}

function SplitDivider({ split }: { split: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="absolute inset-0">
      <div className="absolute top-0 bottom-0 w-px bg-white/70 shadow-[0_0_12px_rgba(255,255,255,0.6)]" style={{ left: `${split * 100}%` }} />
      <div
        className="pointer-events-auto absolute top-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full border border-white/60 bg-black/60 text-[10px] text-white backdrop-blur transition-transform hover:scale-110"
        style={{ left: `${split * 100}%` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          const el = ref.current!;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => {
            const r = el.getBoundingClientRect();
            useApp.getState().set({ split: Math.min(0.95, Math.max(0.05, (ev.clientX - r.left) / r.width)) });
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        ⇆
      </div>
      <div className="absolute left-3 top-3 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white/90 backdrop-blur">Without design</div>
      <div className="absolute right-3 top-3 rounded-md bg-primary/80 px-2 py-1 text-[11px] font-medium text-primary-foreground">With Sponge design</div>
    </div>
  );
}

function Legend({ view, shade }: { view: string; shade: string }) {
  if (view === "diff")
    return (
      <div className="glass absolute bottom-3 right-3 rounded-xl px-3 py-2 text-[10px] text-muted-foreground">
        <div className="mb-1 text-foreground">Change in water depth</div>
        <div className="h-2 w-40 rounded-full" style={{ background: "linear-gradient(90deg,#fa7338,#8c9eb3,#2ed9b8)" }} />
        <div className="mt-0.5 flex justify-between">
          <span>deeper</span>
          <span>same</span>
          <span>shallower</span>
        </div>
      </div>
    );
  if (shade === "depth")
    return (
      <div className="glass absolute bottom-3 right-3 rounded-xl px-3 py-2 text-[10px] text-muted-foreground">
        <div className="mb-1 text-foreground">Water depth</div>
        <div className="flex gap-0.5">
          {[
            ["#b3e5fa", "<15 cm"],
            ["#4fb3e8", "15–30"],
            ["#2563eb", "30–60"],
            ["#4c1d95", ">60 cm"],
          ].map(([c, l]) => (
            <div key={l} className="flex flex-col items-center gap-0.5">
              <div className="h-2 w-10 rounded-sm" style={{ background: c }} />
              <span>{l}</span>
            </div>
          ))}
        </div>
      </div>
    );
  return null;
}
