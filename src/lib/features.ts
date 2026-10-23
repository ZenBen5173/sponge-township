import type { Candidate } from "./data/scene";
import type { Feature, RectFeature } from "./sim/types";
import { newId } from "./store";

export const FEATURE_INFO = {
  square: { label: "Water square", short: "Square", color: "#38bdf8", blurb: "Sunken court that stores floodwater and drains slowly through an outlet pipe." },
  garden: { label: "Rain garden", short: "Garden", color: "#4ade80", blurb: "Planted dip: holds water on top, soaks it into gravel and soil below." },
  permeable: { label: "Permeable walkway", short: "Walkway", color: "#e2c08d", blurb: "Paving with open joints: rain soaks into a stone sub-base instead of running off." },
  drain: { label: "Drain / gutter", short: "Drain", color: "#5eead4", blurb: "Grated channel that catches street water and sends it to the water square (or the drains)." },
  inlet: { label: "Inlet", short: "Inlet", color: "#a5f3fc", blurb: "Kerb inlet that catches street water at one point." },
} as const;

export function countOf(features: Feature[], kind: Feature["kind"]) {
  return features.filter((f) => f.kind === kind).length;
}

export function makeRect(kind: "square" | "garden" | "permeable", x: number, y: number, features: Feature[], cand?: Candidate | null): RectFeature {
  const n = countOf(features, kind) + 1;
  if (kind === "square")
    return { id: newId("sq"), kind, name: `Water square ${n}`, cx: x, cy: y, w: 40, l: 30, rot: cand ? cand.rot : 0, depth: 1, outletD: 0.2 };
  if (kind === "garden") return { id: newId("rg"), kind, name: `Rain garden ${n}`, cx: x, cy: y, w: 14, l: 6, rot: 0, depth: 0.25 };
  return { id: newId("pw"), kind, name: `Permeable walk ${n}`, cx: x, cy: y, w: 3, l: 40, rot: 0, depth: 0 };
}

export function inRect(f: RectFeature, x: number, y: number, pad = 0): boolean {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const px = x - f.cx;
  const py = y - f.cy;
  return Math.abs(px * c + py * s) <= f.w / 2 + pad && Math.abs(-px * s + py * c) <= f.l / 2 + pad;
}

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

/** Topmost feature under a local point. */
export function hitFeature(features: Feature[], x: number, y: number, tol = 3): Feature | null {
  for (let k = features.length - 1; k >= 0; k--) {
    const f = features[k];
    if (f.kind === "inlet" && Math.hypot(f.x - x, f.y - y) < tol + 1) return f;
    if (f.kind === "drain") for (let s = 0; s + 1 < f.pts.length; s++) if (distSeg(x, y, ...f.pts[s], ...f.pts[s + 1]) < tol) return f;
  }
  for (let k = features.length - 1; k >= 0; k--) {
    const f = features[k];
    if ((f.kind === "square" || f.kind === "garden" || f.kind === "permeable") && inRect(f, x, y, 1)) return f;
  }
  return null;
}

export function rectCorners(f: RectFeature): [number, number][] {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [f.cx + (a * f.w * c) / 2 - (b * f.l * s) / 2, f.cy + (a * f.w * s) / 2 + (b * f.l * c) / 2]);
}

export function moveFeature(f: Feature, dx: number, dy: number): Partial<Feature> {
  if (f.kind === "drain") return { pts: f.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
  if (f.kind === "inlet") return { x: f.x + dx, y: f.y + dy };
  return { cx: f.cx + dx, cy: f.cy + dy };
}

export function featureVolume(f: Feature): number {
  if (f.kind === "square") return f.w * f.l * f.depth;
  return 0;
}
