"use client";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import { useId, useRef, useState, type ReactNode } from "react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Glass panel with the library's Spotlight Card treatment: a soft glow follows the cursor and the
 * border lights up on hover.
 */
export function Panel({ children, className, glow = "94,234,212", ...rest }: { children: ReactNode; className?: string; glow?: string } & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, on: false });
  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setPos({ x: e.clientX - r.left, y: e.clientY - r.top, on: true });
      }}
      onMouseLeave={() => setPos((p) => ({ ...p, on: false }))}
      className={cn("glass group/panel relative overflow-hidden rounded-2xl transition-colors duration-300 hover:border-[var(--border-strong)]", className)}
      {...rest}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{ opacity: pos.on ? 1 : 0, background: `radial-gradient(360px circle at ${pos.x}px ${pos.y}px, rgba(${glow},0.09), transparent 70%)` }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/** Segmented control whose highlight glides between options on a spring. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const id = useId();
  return (
    <div className={cn("relative flex rounded-xl border border-border bg-black/30 p-1", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35",
              size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
              active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && <motion.span layoutId={`seg-${id}`} transition={SPRING.default} className="absolute inset-0 -z-10 rounded-lg bg-primary shadow-[0_0_20px_-4px_rgba(94,234,212,0.6)]" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  hint,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => ReactNode;
  hint?: ReactNode;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="num text-foreground">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ["--fill" as string]: `${fill}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div className="text-[10px] leading-snug text-muted-foreground/80">{hint}</div>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="group flex w-full items-start gap-3 text-left">
      <span className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors", checked ? "border-primary/60 bg-primary/30" : "border-border bg-black/30")}>
        <motion.span
          layout
          transition={SPRING.snappy}
          className={cn("absolute top-0.5 size-3.5 rounded-full shadow", checked ? "right-0.5 bg-primary" : "left-0.5 bg-muted-foreground")}
        />
      </span>
      <span>
        <span className="block text-xs text-foreground">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

/** A readout with rolling digits (NumberFlow, as in the library's Pricing Table). */
export function Readout({
  label,
  value,
  unit,
  decimals = 2,
  tone = "default",
  sub,
  className,
}: {
  label: ReactNode;
  value: number | null | undefined;
  unit?: string;
  decimals?: number;
  tone?: "default" | "good" | "bad" | "water";
  sub?: ReactNode;
  className?: string;
}) {
  const color = tone === "good" ? "text-ok" : tone === "bad" ? "text-danger" : tone === "water" ? "text-water" : "text-foreground";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={cn("num flex items-baseline gap-1 text-xl leading-tight", color)}>
        {value === null || value === undefined || !Number.isFinite(value) ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <NumberFlow value={value} format={{ maximumFractionDigits: decimals, minimumFractionDigits: decimals }} />
        )}
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

export function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
