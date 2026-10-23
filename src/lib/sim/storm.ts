import type { StormSpec } from "./types";

/**
 * Rainfall in time. Malaysian convective storms rise fast, peak in the first hour and tail off,
 * so the default shape is front-loaded. The weights are an assumed shape (no gauge-by-gauge record
 * of the 4 Jun 2023 Kapar storm is published), scaled so the total is exactly `totalMm`.
 */
const THUNDERSTORM = [4, 8, 14, 18, 14, 10, 8, 7, 6, 5, 3, 3]; // 12 equal blocks, sums to 100

export const KAPAR_2023: StormSpec = {
  totalMm: 98.5,
  durationMin: 180,
  shape: "thunderstorm",
  highTide: true,
};

/** Rain intensity at time t (s), in metres per second. */
export function rainRate(storm: StormSpec, t: number): number {
  const D = storm.durationMin * 60;
  if (t < 0 || t >= D || storm.totalMm <= 0) return 0;
  const total = storm.totalMm / 1000;
  if (storm.shape === "uniform") return total / D;
  const n = THUNDERSTORM.length;
  const k = Math.min(n - 1, Math.floor((t / D) * n));
  const sum = THUNDERSTORM.reduce((a, b) => a + b, 0);
  return (total * (THUNDERSTORM[k] / sum)) / (D / n);
}

/** Exact rain depth (m) between t0 and t1, so the model can integrate blocks without error. */
export function rainDepth(storm: StormSpec, t0: number, t1: number): number {
  const D = storm.durationMin * 60;
  const a = Math.max(0, t0);
  const b = Math.min(D, t1);
  if (b <= a) return 0;
  if (storm.shape === "uniform") return ((storm.totalMm / 1000) * (b - a)) / D;
  const n = THUNDERSTORM.length;
  const blk = D / n;
  let depth = 0;
  let t = a;
  while (t < b - 1e-9) {
    const k = Math.min(n - 1, Math.floor(t / blk + 1e-9));
    const end = Math.min(b, (k + 1) * blk);
    depth += rainRate(storm, t) * (end - t);
    t = end;
  }
  return depth;
}

/** Hyetograph as (minutes, mm/h) blocks for charts. */
export function hyetograph(storm: StormSpec): { t0: number; t1: number; mmh: number }[] {
  const D = storm.durationMin;
  if (storm.shape === "uniform") return [{ t0: 0, t1: D, mmh: (storm.totalMm / D) * 60 }];
  const n = THUNDERSTORM.length;
  return THUNDERSTORM.map((_, k) => ({
    t0: (k * D) / n,
    t1: ((k + 1) * D) / n,
    mmh: rainRate(storm, ((k + 0.5) * D * 60) / n) * 1000 * 3600,
  }));
}

export function peakIntensity(storm: StormSpec): number {
  return Math.max(...hyetograph(storm).map((b) => b.mmh));
}
