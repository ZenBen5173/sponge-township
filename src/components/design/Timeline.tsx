"use client";
import { Eye, Layers, Mountain, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { fmtClock, Segmented } from "@/components/ui/primitives";
import { getEngine } from "@/lib/engine";
import type { Shade, ViewMode } from "@/lib/render/scene3d";
import { hyetograph } from "@/lib/sim/storm";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function Timeline() {
  const view = useApp((s) => s.view);
  const shade = useApp((s) => s.shade);
  const storm = useApp((s) => s.storm);
  const params = useApp((s) => s.params);
  const run = useApp((s) => s.run);
  const h = useApp((s) => s.history);
  const features = useApp((s) => s.features);
  const set = useApp((s) => s.set);
  const [peak, setPeak] = useState(false);
  const hasDesign = features.length > 0;
  const tEnd = run.tEnd || (storm.durationMin + params.afterMin) * 60;
  const W = 1000;
  const H = 86;
  const blocks = useMemo(() => hyetograph(storm), [storm]);
  const maxR = Math.max(60, ...blocks.map((b) => b.mmh));
  const maxD = Math.max(0.3, ...h.baseStreet.filter(Number.isFinite), ...h.designStreet.filter(Number.isFinite));
  const X = (t: number) => (t / tEnd) * W;
  const line = (ys: number[], scale: number) =>
    h.t
      .map((t, k) => (Number.isFinite(ys[k]) ? `${X(t).toFixed(1)},${(H - 6 - (ys[k] / scale) * (H - 34)).toFixed(1)}` : null))
      .filter(Boolean)
      .join(" ");

  return (
    <div className="card flex flex-col gap-2 rounded-[14px] p-2.5 md:flex-row md:items-center">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Segmented<ViewMode>
          size="sm"
          value={view}
          onChange={(v) => set({ view: v })}
          className="w-[300px] max-w-full"
          options={[
            { value: "without", label: "Without" },
            { value: "with", label: "With", disabled: !hasDesign },
            { value: "split", label: "Split", disabled: !hasDesign },
            { value: "diff", label: "Change", disabled: !hasDesign || run.status === "idle" },
          ]}
        />
        <Segmented<Shade>
          size="sm"
          value={shade}
          onChange={(v) => set({ shade: v })}
          className="w-[150px]"
          options={[
            { value: "real", label: <Sparkles className="size-3" />, title: "Realistic water" },
            { value: "depth", label: <Layers className="size-3" />, title: "Depth colours" },
          ]}
        />
        <button
          onClick={() => getEngine().scene3d?.resetCamera(true)}
          className="lift grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground"
          title="Top view"
        >
          <Eye className="size-3.5" />
        </button>
        <button
          onClick={() => getEngine().scene3d?.resetCamera(false)}
          className="lift grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground"
          title="Oblique view"
        >
          <Mountain className="size-3.5" />
        </button>
        {run.status === "done" && (
          <button
            onClick={() => {
              setPeak(!peak);
              getEngine().showPeaks(!peak);
            }}
            className={cn("lift rounded-lg border px-2 py-1 text-[10px] font-medium", peak ? "inked bg-sun text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground")}
          >
            {peak ? "Showing worst moment" : "Show worst moment"}
          </button>
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[70px] w-full">
          <defs>
            <linearGradient id="rainfill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#3d6cf5" stopOpacity="0.45" />
              <stop offset="1" stopColor="#3d6cf5" stopOpacity="0.1" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={f * W} x2={f * W} y1={0} y2={H} stroke="rgba(22,21,20,0.07)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          ))}
          {blocks.map((b, k) => (
            <rect key={k} x={X(b.t0 * 60) + 1} y={0} width={Math.max(1, X((b.t1 - b.t0) * 60) - 2)} height={(b.mmh / maxR) * 30} fill="url(#rainfill)" rx={2} />
          ))}
          <polyline points={line(h.baseStreet, maxD)} fill="none" stroke="#ff5a36" strokeWidth={2.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hasDesign && <polyline points={line(h.designStreet, maxD)} fill="none" stroke="#2f8f46" strokeWidth={2.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
          {hasDesign && <polyline points={line(h.level, Math.max(1, ...features.map((f) => ("depth" in f ? f.depth : 0))))} fill="none" stroke="#1f3fb0" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
          <line x1={X(run.t)} x2={X(run.t)} y1={0} y2={H} stroke="#161514" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <line x1={X(storm.durationMin * 60)} x2={X(storm.durationMin * 60)} y1={0} y2={H} stroke="#3d6cf5" strokeOpacity={0.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-0.5 font-mono text-[9px] text-muted-foreground">
          <span className="num">00:00</span>
          <span className="flex gap-3">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-3 rounded-sm bg-water/40" />
              rain
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-3 bg-primary" />
              deepest street, without
            </span>
            {hasDesign && (
              <>
                <span className="flex items-center gap-1">
                  <span className="h-0.5 w-3 bg-ok" />
                  with design
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-0.5 w-3 border-t border-dashed border-water-deep" />

                  square level
                </span>
              </>
            )}
          </span>
          <span className="num">{fmtClock(tEnd)}</span>
        </div>
      </div>
    </div>
  );
}
