import { readFileSync } from "node:fs";
import { FloodModel } from "../src/lib/sim/model";
import { KAPAR_2023 } from "../src/lib/sim/storm";
import { DEFAULT_PARAMS, type GridData } from "../src/lib/sim/types";
let j = JSON.parse(readFileSync("tests/fixtures/casira-grid.json", "utf8"));
if (typeof j === "string") j = JSON.parse(j);
const grid: GridData = { nx: j.nx, ny: j.ny, dx: j.dx, z0: j.z0, nBuildings: j.nBuildings, z: Float32Array.from(j.z), land: Uint8Array.from(j.land), buildingId: Int32Array.from(j.buildingId), h0: Float32Array.from(j.h0) };
const m = new FloodModel(grid, [], KAPAR_2023, { ...DEFAULT_PARAMS });
m.advanceTo(3600);
const t0 = performance.now(); let n = 0;
while (performance.now() - t0 < 4000) { m.step(); n++; }
console.log("ms/step", ((performance.now() - t0) / n).toFixed(3), "dt", m.dt.toFixed(3));
