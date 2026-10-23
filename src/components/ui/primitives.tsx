"use client";
import NumberFlow from "@number-flow/react";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** White card with a thin warm rule — the base surface of every panel. */
export function Panel({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card relative overflow-hidden rounded-[14px]", className)} {...rest}>
      {children}
    </div>
  );
}

/** Mono uppercase label (STATUS, SITES…). */
export function Label({ children, className, tone }: { children: ReactNode; className?: string; tone?: "tomato" | "ink" | "water" }) {
  return (
    <div className={cn("label", tone === "tomato" && "!text-primary", tone === "ink" && "!text-foreground", tone === "water" && "!text-water", className)}>{children}</div>
  );
}

/** Rubber stamp — for verdicts like FLOODED, DRY, COURT OPEN, −35 %. */
export function Stamp({ children, tone = "tomato", className, animate = true }: { children: ReactNode; tone?: "tomato" | "ok" | "water" | "ink" | "warn"; className?: string; animate?: boolean }) {
  const color = { tomato: "text-primary", ok: "text-ok", water: "text-water", ink: "text-foreground", warn: "text-warn" }[tone];
  return <span className={cn("stamp text-[11px]", color, animate && "stamp-in", className)}>{children}</span>;
}

/** Primary action: an ink pill with a tomato edge that lifts on hover. */
export function InkButton({ children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cn("btn-ink inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 font-display text-sm font-semibold", className)} {...rest}>
      {children}
    </button>
  );
}

/** Secondary action: white with a thin rule; lifts into an ink shadow on hover. */
export function PaperButton({ children, className, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "lift inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "inked",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Segmented control: the selected option is an ink chip that glides between options. */
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
    <div className={cn("relative flex rounded-xl border border-border bg-muted p-1", className)}>
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
              active ? "text-white" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && <motion.span layoutId={`seg-${id}`} transition={SPRING.default} className="absolute inset-0 -z-10 rounded-lg bg-foreground shadow-[2px_2px_0_0_var(--primary)]" />}
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
      {hint && <div className="text-[10px] leading-snug text-muted-foreground">{hint}</div>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="group flex w-full items-start gap-3 text-left">
      <span className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full border-[1.5px] border-foreground transition-colors", checked ? "bg-primary" : "bg-card")}>
        <motion.span layout transition={SPRING.snappy} className={cn("absolute top-[2px] size-3 rounded-full border-[1.5px] border-foreground bg-card", checked ? "right-[2px]" : "left-[2px]")} />
      </span>
      <span>
        <span className="block text-xs font-medium text-foreground">{label}</span>
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
      {label !== "" && <div className="label truncate">{label}</div>}
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
  return <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}

/** Sponge, the mascot: a yellow sponge with a face that changes with the court's state. */
export function Mascot({ mood = "happy", size = 56, className }: { mood?: "happy" | "worried" | "soaked" | "sleepy"; size?: number; className?: string }) {
  const mouth = {
    happy: "M22 37 Q28 42 34 37",
    worried: "M22 39 Q28 35 34 39",
    soaked: "M24 38 Q28 41 32 38 Q28 44 24 38",
    sleepy: "M24 38 L32 38",
  }[mood];
  return (
    <svg viewBox="0 0 56 56" width={size} height={size} className={cn("overflow-visible", className)} aria-hidden style={{ animation: "bob 3s ease-in-out infinite" }}>
      {mood === "soaked" && (
        <g fill="#3d6cf5">
          <path d="M8 6 q2 4 0 6 q-2 -2 0 -6z" />
          <path d="M48 10 q2 4 0 6 q-2 -2 0 -6z" />
        </g>
      )}
      <rect x="6" y="12" width="44" height="38" rx="9" fill={mood === "soaked" ? "#d8c35a" : "#ffd84d"} stroke="#161514" strokeWidth="2" />
      <rect x="6" y="40" width="44" height="10" rx="0" fill="#2f8f46" stroke="#161514" strokeWidth="2" />
      <rect x="6" y="40" width="44" height="10" rx="0" fill="none" />
      {[
        [15, 20, 2.2],
        [40, 18, 1.8],
        [44, 30, 2],
        [12, 31, 1.6],
        [31, 17, 1.4],
      ].map(([x, y, r]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={r} fill="#e8b92c" />
      ))}
      {mood === "sleepy" ? (
        <g stroke="#161514" strokeWidth="2" strokeLinecap="round">
          <path d="M19 28 h5" />
          <path d="M32 28 h5" />
        </g>
      ) : (
        <g fill="#161514">
          <circle cx="21.5" cy="28" r={mood === "worried" ? 2.6 : 2.2} />
          <circle cx="34.5" cy="28" r={mood === "worried" ? 2.6 : 2.2} />
        </g>
      )}
      <path d={mouth} fill={mood === "soaked" ? "#161514" : "none"} stroke="#161514" strokeWidth="2" strokeLinecap="round" />
      {mood === "worried" && <path d="M44 22 q3 4 0 6 q-3 -2 0 -6z" fill="#3d6cf5" stroke="#161514" strokeWidth="1" />}
    </svg>
  );
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
