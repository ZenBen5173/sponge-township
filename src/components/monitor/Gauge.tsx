"use client";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Tank gauge for the water square: two drifting wave layers ride the level; the 80% line is marked. */
export function Gauge({ fill, level, depth, className }: { fill: number; level: number; depth: number; className?: string }) {
  const f = Math.max(0, Math.min(1.05, fill));
  const tone = f >= 0.8 ? "#fb6a4a" : f >= 0.4 ? "#fbbf24" : "#38bdf8";
  return (
    <div className={cn("relative flex items-stretch gap-3", className)}>
      <div className="relative w-28 shrink-0 overflow-hidden rounded-[22px] border border-border-strong bg-[#06101a] shadow-[inset_0_0_30px_rgba(0,0,0,0.6)] sm:w-32">
        {/* water */}
        <motion.div className="absolute inset-x-0 bottom-0" animate={{ height: `${f * 100}%` }} transition={SPRING.soft}>
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, ${tone}cc, #1d4ed8 140%)` }} />
          <svg className="absolute -top-3 left-0 h-4 w-[200%]" viewBox="0 0 400 16" preserveAspectRatio="none" style={{ animation: "wave-drift 4s linear infinite" }}>
            <path d="M0 8 Q 25 0 50 8 T 100 8 T 150 8 T 200 8 T 250 8 T 300 8 T 350 8 T 400 8 V16 H0Z" fill={tone} fillOpacity={0.8} />
          </svg>
          <svg className="absolute -top-2 left-0 h-3 w-[200%] opacity-60" viewBox="0 0 400 16" preserveAspectRatio="none" style={{ animation: "wave-drift 7s linear infinite reverse" }}>
            <path d="M0 8 Q 25 16 50 8 T 100 8 T 150 8 T 200 8 T 250 8 T 300 8 T 350 8 T 400 8 V16 H0Z" fill="#7dd3fc" fillOpacity={0.6} />
          </svg>
          <div className="absolute inset-0 opacity-30" style={{ background: "repeating-linear-gradient(90deg, transparent 0 10px, rgba(255,255,255,0.05) 10px 11px)" }} />
        </motion.div>
        {/* ticks */}
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <div key={t} className="absolute inset-x-0 border-t border-white/10" style={{ bottom: `${t * 100}%` }}>
            <span className="absolute right-1.5 -top-2 font-mono text-[9px] text-white/40">{Math.round(t * 100)}%</span>
          </div>
        ))}
        <div className="absolute inset-x-0 border-t-2 border-dashed border-danger/70" style={{ bottom: "80%" }}>
          <span className="absolute left-1.5 -top-4 rounded bg-danger/80 px-1 text-[8px] font-medium text-white">80%</span>
        </div>
        {/* court markings at the bottom */}
        <div className="absolute inset-x-3 bottom-2 h-1 rounded-full bg-white/20" />
      </div>
      <div className="flex min-w-0 flex-col justify-between py-1">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Full</div>
          <div className="num text-5xl leading-none" style={{ color: tone }}>
            <NumberFlow value={Math.round(f * 100)} />
            <span className="text-xl text-muted-foreground">%</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Water level</div>
          <div className="num text-2xl leading-none text-foreground">
            <NumberFlow value={Math.round(level * 100)} />
            <span className="text-sm text-muted-foreground"> / {Math.round(depth * 100)} cm</span>
          </div>
        </div>
      </div>
    </div>
  );
}
