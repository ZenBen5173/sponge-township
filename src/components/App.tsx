"use client";
import { Download, Gauge, Layers3, Loader2, Map as MapIcon } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useEffect, useState } from "react";
import { DesignPanel } from "@/components/design/DesignPanel";
import { StormPanel } from "@/components/design/StormPanel";
import { Timeline } from "@/components/design/Timeline";
import { Viewport } from "@/components/design/Viewport";
import { Monitor } from "@/components/monitor/Monitor";
import { AreaPicker } from "@/components/pick/AreaPicker";
import { getEngine } from "@/lib/engine";
import { exportPack } from "@/lib/export";
import { SPRING } from "@/lib/motion";
import { type Phase, type Tool, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const STEPS: { id: Phase; label: string; icon: React.ReactNode }[] = [
  { id: "pick", label: "Pick area", icon: <MapIcon className="size-3.5" /> },
  { id: "design", label: "Design & simulate", icon: <Layers3 className="size-3.5" /> },
  { id: "monitor", label: "Monitor", icon: <Gauge className="size-3.5" /> },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid size-8 place-items-center overflow-hidden rounded-xl border border-primary/40 bg-primary/10">
        <svg viewBox="0 0 32 32" className="size-5 text-primary">
          <rect x="5" y="9" width="22" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M5 19 q 5.5 -3 11 0 t 11 0 V25 H5z" fill="currentColor" opacity="0.55" />
          <circle cx="11" cy="14" r="1.2" fill="currentColor" />
          <circle cx="16" cy="13" r="1.2" fill="currentColor" />
          <circle cx="21" cy="14" r="1.2" fill="currentColor" />
        </svg>
      </div>
      <div className="leading-none">
        <div className="font-display text-lg italic text-foreground">Sponge Township</div>
        <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground">flood simulator · SDP 2026</div>
      </div>
    </div>
  );
}

// Handy for debugging and for scripted end-to-end checks.
if (typeof window !== "undefined") (window as unknown as { __sponge: unknown }).__sponge = { useApp, getEngine };

function PanelToggle({ open, side, onClick }: { open: boolean; side: "left" | "right"; onClick: () => void }) {
  const pointsLeft = (side === "left") === open;
  return (
    <button
      onClick={onClick}
      title={open ? "Hide panel" : "Show panel"}
      className="glass group mt-2 grid h-10 w-5 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-primary"
    >
      <svg viewBox="0 0 8 12" className={cn("size-2.5 transition-transform group-hover:scale-125", pointsLeft ? "" : "rotate-180")}>
        <path d="M6 1 1 6l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export default function App() {
  const phase = useApp((s) => s.phase);
  const scene = useApp((s) => s.scene);
  const sceneStatus = useApp((s) => s.sceneStatus);
  const toast = useApp((s) => s.toast);
  const set = useApp((s) => s.set);
  const [exporting, setExporting] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // tool shortcuts
  useEffect(() => {
    const keys: Record<string, Tool> = { v: "select", "1": "square", "2": "drain", "3": "inlet", "4": "permeable", "5": "garden" };
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey) return;
      const t = keys[e.key.toLowerCase()];
      if (t && useApp.getState().phase === "design") set({ tool: t, drawing: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  const canDesign = !!scene || sceneStatus === "loading";

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-dvh flex-col bg-background">
        <header className="relative z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-4">
          <Logo />
          <nav className="flex rounded-xl border border-border bg-black/30 p-1">
            {STEPS.map((s, k) => {
              const active = phase === s.id;
              const disabled = s.id === "design" && !canDesign;
              return (
                <button
                  key={s.id}
                  disabled={disabled}
                  onClick={() => set({ phase: s.id })}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 sm:px-3",
                    active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  title={disabled ? "Pick an area first" : s.label}
                >
                  {active && <motion.span layoutId="step-pill" transition={SPRING.default} className="absolute inset-0 rounded-lg bg-primary" />}
                  <span className="relative">{s.icon}</span>
                  <span className="relative hidden md:inline">
                    <span className="mr-1 opacity-60">{k + 1}</span>
                    {s.label}
                  </span>
                </button>
              );
            })}
          </nav>
          <button
            disabled={!scene || exporting}
            onClick={async () => {
              setExporting(true);
              try {
                await exportPack();
              } finally {
                setExporting(false);
              }
            }}
            className="group flex items-center gap-1.5 rounded-xl border border-border bg-black/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-40"
            title="Before/after images and a numbers summary for the pitch deck"
          >
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5 transition-transform group-hover:translate-y-0.5" />}
            <span className="hidden sm:inline">Export results</span>
          </button>
        </header>

        <main className="relative min-h-0 flex-1">
          {/* the picker stays mounted so the map keeps its place */}
          <div className={cn("absolute inset-0", phase === "pick" ? "z-10" : "pointer-events-none invisible")}>
            <AreaPicker />
          </div>
          {canDesign && (
            <div className={cn("absolute inset-0", phase === "design" ? "z-10" : "pointer-events-none invisible")}>
              <Viewport />
              <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-3">
                <div className="flex min-h-0 flex-1 justify-between gap-3">
                  <div className="pointer-events-auto hidden min-h-0 shrink-0 items-start gap-1 md:flex">
                    <AnimatePresence initial={false}>
                      {leftOpen && (
                        <motion.div
                          key="l"
                          initial={{ opacity: 0, x: -24, width: 0 }}
                          animate={{ opacity: 1, x: 0, width: 290 }}
                          exit={{ opacity: 0, x: -24, width: 0 }}
                          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                          className="flex h-full min-h-0 flex-col overflow-hidden"
                        >
                          <DesignPanel />
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <PanelToggle open={leftOpen} side="left" onClick={() => setLeftOpen((v) => !v)} />
                  </div>
                  <div className="pointer-events-auto ml-auto flex min-h-0 shrink-0 items-start gap-1">
                    <PanelToggle open={rightOpen} side="right" onClick={() => setRightOpen((v) => !v)} />
                    <AnimatePresence initial={false}>
                      {rightOpen && (
                        <motion.div
                          key="r"
                          initial={{ opacity: 0, x: 24, width: 0 }}
                          animate={{ opacity: 1, x: 0, width: 320 }}
                          exit={{ opacity: 0, x: 24, width: 0 }}
                          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                          className="flex h-full min-h-0 max-w-[calc(100vw-60px)] flex-col overflow-hidden"
                        >
                          <StormPanel />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
                <div className="pointer-events-auto hidden sm:block">
                  <Timeline />
                </div>
                <div className="pointer-events-auto glass rounded-xl px-3 py-2 text-[11px] text-muted-foreground sm:hidden">
                  The designer works best on a laptop.{" "}
                  <button onClick={() => set({ phase: "monitor" })} className="text-primary underline">
                    Open the resident dashboard
                  </button>
                </div>
              </div>
            </div>
          )}
          {phase === "monitor" && (
            <div className="absolute inset-0 z-10 bg-[radial-gradient(ellipse_at_top,#10202e,transparent_60%)]">
              <Monitor embedded />
            </div>
          )}
        </main>

        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              className="glass fixed bottom-24 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-xl px-4 py-2.5 text-xs text-foreground"
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
