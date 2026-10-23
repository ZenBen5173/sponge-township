"use client";
import { ChevronDown, CloudRain, Pause, Play, RotateCcw, Scale, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { GenerateButton } from "@/components/ui/generate-button";
import { fmtClock, fmtDuration, Panel, Readout, Segmented, Slider, Toggle } from "@/components/ui/primitives";
import { getEngine } from "@/lib/engine";
import { KAPAR_2023, peakIntensity } from "@/lib/sim/storm";
import type { Stats } from "@/lib/sim/types";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const SPEEDS = [
  { value: "300", label: "5 min/s" },
  { value: "900", label: "15 min/s" },
  { value: "1800", label: "30 min/s" },
  { value: "Infinity", label: "Max" },
];

export function StormPanel() {
  const storm = useApp((s) => s.storm);
  const preset = useApp((s) => s.preset);
  const params = useApp((s) => s.params);
  const run = useApp((s) => s.run);
  const features = useApp((s) => s.features);
  const stats = useApp((s) => s.stats);
  const finals = useApp((s) => s.finals);
  const set = useApp((s) => s.set);
  const setStorm = useApp((s) => s.setStorm);
  const setParams = useApp((s) => s.setParams);
  const [adv, setAdv] = useState(false);
  const solver = useApp((s) => s.solver);
  const eng = getEngine();
  const busy = run.status === "running" || run.status === "starting" || run.status === "paused";
  const base = finals.base ?? stats.base;
  const design = finals.design ?? stats.design;

  return (
    <Panel className="flex max-h-full flex-col p-3" glow="56,189,248">
      <div className="text-[10px] uppercase tracking-[0.18em] text-water">Storm</div>
      <div className="font-display text-xl leading-tight">Let it rain</div>

      <div className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 scroll-thin">
        <Segmented
          value={preset}
          onChange={(v) => (v === "kapar" ? set({ storm: { ...KAPAR_2023, highTide: storm.highTide }, preset: "kapar" }) : set({ preset: "custom" }))}
          options={[
            { value: "kapar", label: "4 Jun 2023 Kapar" },
            { value: "custom", label: "Custom" },
          ]}
        />
        <AnimatePresence initial={false} mode="wait">
          {preset === "kapar" ? (
            <motion.div key="k" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="rounded-xl border border-border bg-black/25 p-2.5 text-[11px] leading-snug text-muted-foreground">
                <span className="num text-foreground">98.5 mm</span> in about <span className="num text-foreground">3 h</span> — the storm that flooded Bandar Bukit Raja. Front-loaded thunderstorm shape, peak{" "}
                <span className="num text-foreground">{peakIntensity(storm).toFixed(0)} mm/h</span>.
              </div>
            </motion.div>
          ) : (
            <motion.div key="c" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-2 overflow-hidden">
              <Slider label="Rainfall" value={storm.totalMm} min={10} max={300} step={0.5} onChange={(v) => setStorm({ totalMm: v })} format={(v) => `${v} mm`} />
              <Slider label="Duration" value={storm.durationMin} min={15} max={720} step={15} onChange={(v) => setStorm({ durationMin: v })} format={(v) => fmtDuration(v * 60)} />
              <Segmented
                size="sm"
                value={storm.shape}
                onChange={(v) => setStorm({ shape: v })}
                options={[
                  { value: "thunderstorm", label: "Thunderstorm" },
                  { value: "uniform", label: "Steady" },
                ]}
              />
              <div className="num text-[10px] text-muted-foreground">Peak {peakIntensity(storm).toFixed(0)} mm/h · average {((storm.totalMm / storm.durationMin) * 60).toFixed(0)} mm/h</div>
            </motion.div>
          )}
        </AnimatePresence>
        <Toggle
          checked={storm.highTide}
          onChange={(v) => set({ storm: { ...storm, highTide: v } })}
          label="High tide"
          hint={`Outfalls to the Klang estuary back up: drains carry ${Math.round(params.tideFactor * 100)}% of normal until an hour after the rain.`}
        />

        <button onClick={() => setAdv((a) => !a)} className="flex w-full items-center justify-between text-[11px] text-muted-foreground hover:text-foreground">
          Model assumptions
          <ChevronDown className={cn("size-3.5 transition-transform", adv && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {adv && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-2 overflow-hidden">
              <Slider label="Existing drain capacity" value={params.drainMmPerHour} min={0} max={80} onChange={(v) => setParams({ drainMmPerHour: v })} format={(v) => `${v} mm/h`} hint="Over the whole area; ageing, silted drains are lower." />
              <Slider label="Drains left at high tide" value={Math.round(params.tideFactor * 100)} min={0} max={100} step={5} onChange={(v) => setParams({ tideFactor: v / 100 })} format={(v) => `${v}%`} />
              <Slider label="'Flooded building' threshold" value={Math.round(params.buildingThreshold * 100)} min={5} max={50} onChange={(v) => setParams({ buildingThreshold: v / 100 })} format={(v) => `${v} cm`} hint="Water at the building edge deeper than a doorstep." />
              <Slider label="Simulate after the rain" value={params.afterMin} min={60} max={480} step={30} onChange={(v) => setParams({ afterMin: v })} format={(v) => fmtDuration(v * 60)} />
            </motion.div>
          )}
        </AnimatePresence>

        {!busy ? (
          <div className="space-y-1.5">
            <GenerateButton
              hue={175}
              label={run.status === "done" ? "Run again" : "Run storm"}
              activeLabel="Raining…"
              isGenerating={false}
              onClick={() => eng.startRun()}
              className="w-full"
              icon={<CloudRain className="gen-btn-svg" strokeWidth={1.6} fill="none" stroke="#e8e8e8" />}
            />
            <div className="text-center text-[10px] text-muted-foreground">
              {features.length ? "Runs without and with your design on the same storm." : "No features yet — runs the town as it is today."}
            </div>
          </div>
        ) : (
          <div className="space-y-2 rounded-xl border border-border bg-black/25 p-2.5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => (run.status === "paused" ? eng.resume() : eng.pause())}
                className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground transition-transform active:scale-95"
                title={run.status === "paused" ? "Resume" : "Pause"}
              >
                {run.status === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />}
              </button>
              <button onClick={() => eng.stop()} className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground" title="Stop">
                <Square className="size-3.5" />
              </button>
              <div className="flex-1 text-right">
                <div className="num text-lg leading-none text-foreground">{fmtClock(run.t)}</div>
                <div className="text-[10px] text-muted-foreground">of {fmtClock(run.tEnd)} simulated</div>
                {solver && (
                  <div className={cn("mt-0.5 inline-block rounded px-1 text-[9px] uppercase tracking-wider", solver === "gpu" ? "bg-primary/15 text-primary" : "bg-white/5 text-muted-foreground")}>
                    {solver === "gpu" ? "WebGPU solver" : "CPU solver"}
                  </div>
                )}
              </div>
            </div>
            <Segmented size="sm" value={String(run.speed)} onChange={(v) => eng.setSpeed(Number(v))} options={SPEEDS} />
          </div>
        )}

        <Results base={features.length ? base : design ?? base} design={features.length ? design : undefined} done={run.status === "done"} />
        {run.status === "done" && (
          <button onClick={() => eng.stop()} className="flex w-full items-center justify-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground">
            <RotateCcw className="size-3" /> Clear results
          </button>
        )}
      </div>
    </Panel>
  );
}

function pct(a?: number, b?: number) {
  if (a === undefined || b === undefined || !(a > 0)) return null;
  return ((b - a) / a) * 100;
}

function Delta({ a, b, lowerIsBetter = true }: { a?: number; b?: number; lowerIsBetter?: boolean }) {
  const p = pct(a, b);
  if (p === null || !Number.isFinite(p)) return null;
  const good = lowerIsBetter ? p < -0.5 : p > 0.5;
  const bad = lowerIsBetter ? p > 0.5 : p < -0.5;
  return (
    <span className={cn("num rounded px-1 py-px text-[10px]", good ? "bg-ok/15 text-ok" : bad ? "bg-danger/15 text-danger" : "bg-white/5 text-muted-foreground")}>
      {p > 0 ? "+" : ""}
      {p.toFixed(0)}%
    </span>
  );
}

function Results({ base, design, done }: { base?: Stats; design?: Stats; done: boolean }) {
  const thr = useApp((s) => s.params.buildingThreshold);
  const near = useApp((s) => s.near);
  if (!base && !design) return null;
  const rows = [
    { label: "Peak street depth", a: base?.peakStreetDepth, b: design?.peakStreetDepth, unit: "m", d: 2, now: [base?.streetDepth, design?.streetDepth] },
    { label: `Buildings with > ${Math.round(thr * 100)} cm at the door`, a: base?.peakBuildingsWet, b: design?.peakBuildingsWet, unit: "", d: 0, now: [base?.buildingsWet, design?.buildingsWet] },
    { label: "Street area under > 15 cm", a: base?.peakFloodedRoadArea, b: design?.peakFloodedRoadArea, unit: "m²", d: 0, now: [base?.floodedRoadArea, design?.floodedRoadArea] },
  ];
  const nb = done ? near.base : near.live?.base;
  const nd = done ? near.design : near.live?.design;
  const sq = design?.features.filter((f) => f.kind === "square") ?? [];
  const others = design?.features.filter((f) => f.kind !== "square") ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium text-foreground">{done ? "Results" : "Live readouts"}</div>
        {design && (
          <div className="flex gap-2 text-[9px] uppercase tracking-wider text-muted-foreground">
            <span>Without</span>
            <span className="text-primary">With</span>
          </div>
        )}
      </div>
      {design && (nb || nd) && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.1em] text-primary">Within 150 m of your design</span>
            <span className="text-[9px] text-muted-foreground">{nb?.buildings ?? nd?.buildings} buildings</span>
          </div>
          {[
            ["Deepest street", nb?.peakDepth, nd?.peakDepth, "m", 2],
            [`Homes > ${Math.round(thr * 100)} cm at door`, nb?.buildingsWet, nd?.buildingsWet, "", 0],
            ["Street > 15 cm", nb?.floodedRoadArea, nd?.floodedRoadArea, "m²", 0],
          ].map(([l, a, b, u, d]) => (
            <div key={l as string} className="num mt-1 flex items-center justify-between gap-2 text-[11px]">
              <span className="font-sans text-muted-foreground">{l}</span>
              <span className="flex items-center gap-1.5">
                <span className="text-foreground">{(a as number | undefined)?.toFixed(d as number) ?? "—"}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-ok">{(b as number | undefined)?.toFixed(d as number) ?? "—"}</span>
                <span className="text-muted-foreground">{u}</span>
                <Delta a={a as number | undefined} b={b as number | undefined} />
              </span>
            </div>
          ))}
          {!done && <div className="mt-0.5 text-[9px] text-muted-foreground">right now · worst moment shown when the run ends</div>}
        </div>
      )}
      {rows.map((r) => (
        <div key={r.label} className="rounded-xl border border-border bg-black/25 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{r.label}</span>
            {design && <Delta a={r.a} b={r.b} />}
          </div>
          <div className="mt-0.5 flex items-end justify-between gap-2">
            <Readout label="" value={r.a} unit={r.unit} decimals={r.d} tone={design ? "default" : "water"} className="[&>div:first-child]:hidden" />
            {design && <Readout label="" value={r.b} unit={r.unit} decimals={r.d} tone="good" className="text-right [&>div:first-child]:hidden [&>div]:justify-end" />}
          </div>
          {!done && (
            <div className="num text-[9px] text-muted-foreground">
              now {r.now[0]?.toFixed(r.d) ?? "—"}
              {design ? ` / ${r.now[1]?.toFixed(r.d) ?? "—"}` : ""} {r.unit}
            </div>
          )}
        </div>
      ))}
      {sq.map((f) => (
        <div key={f.id} className="rounded-xl border border-water/30 bg-water/5 px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-foreground">{f.name}</span>
            <span className="num text-[10px] text-water">{Math.round((f.fill ?? 0) * 100)}% full</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
            <motion.div className="h-full rounded-full bg-gradient-to-r from-sky-500 to-teal-300" animate={{ width: `${Math.min(100, (f.fill ?? 0) * 100)}%` }} transition={{ duration: 0.3 }} />
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <Readout label="Stored now" value={f.stored} unit="m³" decimals={0} tone="water" />
            <Readout label="Peak stored" value={f.peakStored} unit="m³" decimals={0} />
            <Readout label="Level" value={(f.level ?? 0) * 100} unit="cm" decimals={0} />
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Empty after</div>
              <div className="num text-sm leading-tight text-foreground">
                {f.emptyAt != null
                  ? fmtDuration(f.emptyAt - durationOf())
                  : f.peakStored < 1
                    ? "—"
                    : done || (design?.t ?? 0) > durationOf()
                      ? f.projectedEmpty == null
                        ? "blocked"
                        : `~${fmtDuration(Math.max(0, (design?.t ?? 0) - durationOf()) + f.projectedEmpty)}`
                      : "filling…"}
              </div>
              <div className="text-[9px] text-muted-foreground">after rain stops{f.emptyAt == null && f.peakStored > 1 && (done || (design?.t ?? 0) > durationOf()) ? " (projected)" : ""}</div>
            </div>
          </div>
        </div>
      ))}
      {others.length > 0 && (
        <div className="rounded-xl border border-border bg-black/25 px-2.5 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Other features</div>
          {others.map((f) => (
            <div key={f.id} className="num flex justify-between py-0.5 text-[11px]">
              <span className="truncate font-sans text-foreground">{f.name}</span>
              <span className="text-muted-foreground">
                {f.captured !== undefined ? `${Math.round(f.captured)} m³ caught` : `${Math.round(f.stored)} / ${Math.round(f.capacity)} m³ (peak ${Math.round(f.peakStored)})`}
              </span>
            </div>
          ))}
        </div>
      )}
      {(design ?? base) && <BalanceCard s={(design ?? base)!} />}
    </div>
  );
}

function durationOf() {
  return useApp.getState().storm.durationMin * 60;
}

function BalanceCard({ s }: { s: Stats }) {
  const b = s.balance;
  const items = [
    ["On the ground", b.surface, "#38bdf8"],
    ["In features", b.featureStore, "#5eead4"],
    ["Soaked in", b.infiltrated, "#4ade80"],
    ["Down the drains", b.drained, "#a78bfa"],
    ["Flowed out of area", b.leftArea, "#94a3b8"],
  ] as const;
  const total = Math.max(1, b.rain + b.initial);
  return (
    <div className="rounded-xl border border-border bg-black/25 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <Scale className="size-3" /> Water balance
        </span>
        <span className={cn("num text-[10px]", Math.abs(b.error) < 1e-6 ? "text-ok" : "text-warn")}>error {(Math.abs(b.error) * 100).toExponential(1)}%</span>
      </div>
      <div className="mt-1.5 flex h-2 overflow-hidden rounded-full">
        {items.map(([l, v, c]) => (
          <div key={l} style={{ width: `${(v / total) * 100}%`, background: c }} title={l} />
        ))}
      </div>
      <div className="num mt-1.5 grid grid-cols-2 gap-x-2 text-[10px] text-muted-foreground">
        <span>Rain in</span>
        <span className="text-right text-foreground">{Math.round(b.rain).toLocaleString()} m³</span>
        {items.map(([l, v, c]) => (
          <span key={l} className="contents">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: c }} />
              {l}
            </span>
            <span className="text-right">{Math.round(v).toLocaleString()} m³</span>
          </span>
        ))}
      </div>
    </div>
  );
}
