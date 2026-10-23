"use client";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The court as a tank beside a flood staff: two drifting wave layers ride the level; the 80% line is marked. */
export function Gauge({ fill, level, depth, className }: { fill: number; level: number; depth: number; className?: string }) {
  const f = Math.max(0, Math.min(1.05, fill));
  const tone = f >= 0.8 ? "#ff5a36" : f >= 0.4 ? "#b7791f" : "#3d6cf5";
  return (
    <div className={cn("relative flex items-stretch gap-3", className)}>
      <div className="flex shrink-0 gap-1.5">
        {/* flood staff: red and white bands every 10% */}
        <div className="relative w-4 overflow-hidden rounded-[4px] border-[1.5px] border-foreground staff-bands" aria-hidden>
          {[0.2, 0.4, 0.6, 0.8].map((t) => (
            <span key={t} className="absolute -left-px w-2 border-t-[1.5px] border-foreground" style={{ bottom: `${t * 100}%` }} />
          ))}
        </div>
        <div className="relative w-28 overflow-hidden rounded-[18px] border-[1.5px] border-foreground bg-card shadow-[4px_4px_0_0_var(--foreground)] sm:w-32">
          {/* water */}
          <motion.div className="absolute inset-x-0 bottom-0" animate={{ height: `${f * 100}%` }} transition={SPRING.soft}>
            <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, #5b84f7, #1f3fb0 160%)" }} />
            <svg className="absolute -top-3 left-0 h-4 w-[200%]" viewBox="0 0 400 16" preserveAspectRatio="none" style={{ animation: "wave-drift 4s linear infinite" }}>
              <path d="M0 8 Q 25 0 50 8 T 100 8 T 150 8 T 200 8 T 250 8 T 300 8 T 350 8 T 400 8 V16 H0Z" fill="#5b84f7" />
            </svg>
            <svg className="absolute -top-2 left-0 h-3 w-[200%] opacity-70" viewBox="0 0 400 16" preserveAspectRatio="none" style={{ animation: "wave-drift 7s linear infinite reverse" }}>
              <path d="M0 8 Q 25 16 50 8 T 100 8 T 150 8 T 200 8 T 250 8 T 300 8 T 350 8 T 400 8 V16 H0Z" fill="#dbe6ff" fillOpacity={0.7} />
            </svg>
          </motion.div>
          {/* ticks */}
          {[0.25, 0.5, 0.75].map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-dashed border-foreground/15" style={{ bottom: `${t * 100}%` }}>
              <span className="absolute -top-2 right-1.5 font-mono text-[9px] text-foreground/45 mix-blend-multiply">{Math.round(t * 100)}%</span>
            </div>
          ))}
          <div className="absolute inset-x-0 border-t-2 border-dashed border-primary" style={{ bottom: "80%" }}>
            <span className="absolute -top-[18px] left-1.5 rounded border border-foreground bg-primary px-1 font-mono text-[8px] font-bold text-white">80%</span>
          </div>
          {/* court markings at the bottom */}
          <div className="absolute inset-x-3 bottom-2 h-1 rounded-full bg-foreground/15" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-between py-1">
        <div>
          <div className="label">Full</div>
          <div className="num text-5xl font-bold leading-none" style={{ color: tone }}>
            <NumberFlow value={Math.round(f * 100)} />
            <span className="text-xl text-muted-foreground">%</span>
          </div>
        </div>
        <div>
          <div className="label">Water level</div>
          <div className="num text-2xl leading-none text-foreground">
            <NumberFlow value={Math.round(level * 100)} />
            <span className="text-sm text-muted-foreground"> / {Math.round(depth * 100)} cm</span>
          </div>
        </div>
      </div>
    </div>
  );
}
