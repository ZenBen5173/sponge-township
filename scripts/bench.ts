import { readFileSync } from "node:fs";
import { FloodModel } from "../src/lib/sim/model";
import { KAPAR_2023 } from "../src/lib/sim/storm";
import { DEFAULT_PARAMS, type GridData } from "../src/lib/sim/types";

const raw = readFileSync("tests/fixtures/casira-grid.json", "utf8");
let j = JSON.parse(raw);
if (typeof j === "string") j = JSON.parse(j);
const grid: GridData = { nx: j.nx, ny: j.ny, dx: j.dx, z0: j.z0, nBuildings: j.nBuildings, z: Float32Array.from(j.z), land: Uint8Array.from(j.land), buildingId: Int32Array.from(j.buildingId), h0: Float32Array.from(j.h0) };
const withF = process.argv.includes("--design");
const m = new FloodModel(grid, withF ? j.features : [], KAPAR_2023, { ...DEFAULT_PARAMS, afterMin: 180 });
const t0 = performance.now();
let last = t0;
let steps = 0;
while (!m.done) {
  m.step();
  steps++;
  if (performance.now() - last > 2000) {
    last = performance.now();
    const s = m.stats(1);
    console.log(`t=${(m.t / 60).toFixed(0)}min dt=${m.dt.toFixed(2)} ms/step=${((last - t0) / steps).toFixed(2)} street=${s.streetDepth.toFixed(2)} p95=${s.streetP95} bld=${s.buildingsWet}`);
  }
}
const s = m.stats(1);
console.log(JSON.stringify({ wall: (performance.now() - t0) / 1000, steps, peak: s.peakStreetDepth, pb: s.peakBuildingsWet, area: s.peakFloodedRoadArea, bal: s.balance, feats: s.features }, null, 1));
