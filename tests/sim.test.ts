import { describe, expect, it } from "vitest";
import { FloodModel } from "../src/lib/sim/model";
import { KAPAR_2023, rainDepth } from "../src/lib/sim/storm";
import { DEFAULT_PARAMS, Land, type Feature, type GridData } from "../src/lib/sim/types";

function grid(nx: number, ny: number, dx: number, zf: (x: number, y: number) => number, landf?: (i: number, j: number) => number): GridData {
  const N = nx * ny;
  const z = new Float32Array(N);
  const land = new Uint8Array(N);
  const buildingId = new Int32Array(N).fill(-1);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      z[c] = zf((i + 0.5) * dx, (j + 0.5) * dx);
      land[c] = landf ? landf(i, j) : Land.Road;
    }
  // Number buildings by connected blocks of Building cells (4-neighbour).
  let nb = 0;
  for (let c = 0; c < N; c++) {
    if (land[c] !== Land.Building || buildingId[c] >= 0) continue;
    const stack = [c];
    buildingId[c] = nb;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % nx;
      const j = (k / nx) | 0;
      for (const d of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1]) {
        if (d >= 0 && land[d] === Land.Building && buildingId[d] < 0) {
          buildingId[d] = nb;
          stack.push(d);
        }
      }
    }
    nb++;
  }
  return { nx, ny, dx, z, z0: 0, land, buildingId, nBuildings: nb, h0: new Float32Array(N) };
}

const noRain = { totalMm: 0, durationMin: 1, shape: "uniform" as const, highTide: false };

describe("storm", () => {
  it("integrates exactly to the total", () => {
    const D = KAPAR_2023.durationMin * 60;
    expect(rainDepth(KAPAR_2023, 0, D) * 1000).toBeCloseTo(98.5, 9);
    let s = 0;
    for (let t = 0; t < D + 100; t += 7.3) s += rainDepth(KAPAR_2023, t, t + 7.3);
    expect(s * 1000).toBeCloseTo(98.5, 9);
  });
});

describe("solver", () => {
  it("keeps a lake at rest on uneven ground (well-balanced)", () => {
    const g = grid(60, 60, 2, (x, y) => 2 + 0.6 * Math.sin(x / 9) * Math.cos(y / 7) + ((x - 60) ** 2 + (y - 60) ** 2) / 900, () => Land.Water);
    const level = 3.2;
    for (let c = 0; c < g.z.length; c++) g.h0[c] = Math.max(0, level - g.z[c]);
    // keep the lake off the edges so open boundaries do nothing
    for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) if (i < 3 || j < 3 || i > 56 || j > 56) g.h0[j * 60 + i] = 0;
    const m = new FloodModel(g, [], noRain, { ...DEFAULT_PARAMS, drainMmPerHour: 0 });
    m.advanceTo(600);
    let maxDev = 0;
    for (let c = 0; c < g.z.length; c++) if (m.h[c] > 0.01) maxDev = Math.max(maxDev, Math.abs(m.zb[c] + m.h[c] - level));
    expect(maxDev).toBeLessThan(1e-6);
  });

  it("conserves water to rounding in a full storm with every feature", () => {
    const nx = 120;
    const ny = 100;
    const g = grid(
      nx,
      ny,
      2,
      (x, y) => 5 + 0.004 * x + 0.002 * y + 0.05 * Math.sin(x / 13) * Math.sin(y / 11),
      (i, j) => {
        if (j % 20 < 4) return Land.Road;
        if (i % 24 < 4) return Land.Road;
        if (i % 24 > 7 && i % 24 < 20 && j % 20 > 6 && j % 20 < 17) return Land.Building;
        if (i > 80 && j > 50) return Land.Green;
        return Land.Open;
      },
    );
    const features: Feature[] = [
      { id: "sq", kind: "square", name: "Square", cx: 180, cy: 150, w: 40, l: 30, rot: 0.2, depth: 1, outletD: 0.2 },
      { id: "rg", kind: "garden", name: "Garden", cx: 60, cy: 40, w: 12, l: 8, rot: 0, depth: 0.25 },
      { id: "pw", kind: "permeable", name: "Walk", cx: 100, cy: 100, w: 4, l: 60, rot: 0, depth: 0 },
      { id: "dr", kind: "drain", name: "Drain", pts: [[100, 4], [160, 4], [175, 140]], capacityPerM: 0.01 },
      { id: "in", kind: "inlet", name: "Inlet", x: 40, y: 4, capacity: 0.05 },
    ];
    const m = new FloodModel(g, features, KAPAR_2023, { ...DEFAULT_PARAMS, afterMin: 60 });
    let worst = 0;
    while (!m.done) {
      m.advanceTo(m.t + 900);
      worst = Math.max(worst, Math.abs(m.balance().error));
    }
    const b = m.balance();
    expect(b.rain).toBeCloseTo(0.0985 * nx * ny * 4, 3);
    expect(worst).toBeLessThan(1e-9);
    const st = m.stats(1);
    const sq = st.features.find((f) => f.id === "sq")!;
    expect(sq.peakStored).toBeGreaterThan(50);
    expect(st.features.find((f) => f.id === "pw")!.peakStored).toBeGreaterThan(0);
    for (let c = 0; c < m.N; c++) expect(m.h[c]).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("a water square beside a street lowers its peak; a gutter delivers street water into it", () => {
    const nx = 100;
    const ny = 60;
    // a street (y 50–70 m) running downhill west→east between open strips and solid blocks
    const zf = (x: number) => 6 - 0.006 * x;
    const landf = (i: number, j: number) => (j >= 25 && j < 35 ? Land.Road : j >= 20 && j < 40 ? Land.Open : Land.Building);
    const params = { ...DEFAULT_PARAMS, drainMmPerHour: 10, afterMin: 30 };
    const court: Feature = { id: "sq", kind: "square", name: "Square", cx: 150, cy: 45, w: 40, l: 9, rot: 0, depth: 1, outletD: 0.2 };
    const gutter: Feature = { id: "dr", kind: "drain", name: "Gutter", pts: [[20, 60], [150, 60], [150, 50]], capacityPerM: 0.006 };
    const run = (fs: Feature[]) => {
      const m = new FloodModel(grid(nx, ny, 2, zf, landf), fs, KAPAR_2023, params);
      m.advanceTo(m.tEnd);
      return m.stats(1);
    };
    const a = run([]);
    const b = run([court]);
    const c = run([court, gutter]);
    expect(b.features.find((f) => f.id === "sq")!.peakStored).toBeGreaterThan(100);
    expect(b.peakStreetDepth).toBeLessThan(a.peakStreetDepth);
    // the gutter catches street water and the court never takes more than it can hold
    const g = c.features.find((f) => f.id === "dr")!;
    const sq = c.features.find((f) => f.id === "sq")!;
    expect(g.captured).toBeGreaterThan(100);
    expect(sq.peakStored).toBeLessThanOrEqual(sq.capacity * 1.05);
    for (const s of [a, b, c]) expect(Math.abs(s.balance.error)).toBeLessThan(1e-9);
  }, 60_000);

  it("runs a 300 × 300 grid fast enough for the browser", () => {
    const g = grid(300, 300, 2, (x, y) => 5 + 0.002 * x + 0.03 * Math.sin(x / 17) * Math.sin(y / 19), (i, j) => (j % 25 < 4 || i % 30 < 4 ? Land.Road : (i % 30) > 8 && (j % 25) > 7 && (j % 25) < 20 ? Land.Building : Land.Open));
    const m = new FloodModel(g, [], KAPAR_2023, DEFAULT_PARAMS);
    m.advanceTo(1800); // warm the field up
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 2000) {
      m.step();
      n++;
    }
    const ms = (performance.now() - t0) / n;
    console.log(`300×300: ${ms.toFixed(2)} ms/step, dt ${m.dt.toFixed(2)} s → ${(m.dt / (ms / 1000)).toFixed(0)}× real time`);
    expect(ms).toBeLessThan(25);
  }, 60_000);
});
