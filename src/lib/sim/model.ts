/**
 * Sponge Township flood model.
 *
 * A 2-D shallow-water model of rain falling on a town, flowing over the ground, pooling, soaking in
 * and leaving through drains. The numerical core is the "local inertial" scheme used by
 * LISFLOOD-FP-class urban flood models (Bates, Horritt & Fewtrell 2010, J. Hydrology 387; with the
 * θ-smoothing of de Almeida et al. 2012, Water Resour. Res. 48), arranged as in the MIT-licensed
 * Deluge solver (github.com/rkottomt/deluge-flood-sim): well-balanced face depths, semi-implicit
 * Manning friction and a positivity-preserving donor-cell flux limiter, so depths never go negative
 * and water is neither created nor lost.
 *
 * Grid: h at cell centres; qx[c] is the unit discharge (m²/s) through the EAST face of cell c and
 * qy[c] through its SOUTH face. Row j = 0 is the north edge. The last column / row of qx / qy holds
 * the open-boundary outflow.
 *
 * Around that core:
 *  - buildings are solid blocks; rain on roofs is shed at the foot of the building (downpipes);
 *  - every road cell has a roadside drain inlet feeding one drain network of limited capacity,
 *    reduced while the tide is high (outfalls back up);
 *  - soil soaks up water at a Horton rate that falls as it wets;
 *  - permeable paving and rain gardens soak water into an underground store that empties slowly;
 *  - a water square is a storage node (as 1-D/2-D models such as TUFLOW treat ponds): street water
 *    pours over its rim by the weir equation, its level rises, and an outlet pipe empties it by
 *    the orifice equation into whatever drain capacity is left over.
 *
 * Every external change is booked in Float64, so rain in = water on the ground + in features +
 * soaked in + drained + left the area, to rounding.
 */
import { rainDepth, rainRate } from "./storm";
import {
  Land,
  type Balance,
  type Feature,
  type FeatureStat,
  type GridData,
  type ModelParams,
  type RectFeature,
  type Stats,
  type StormSpec,
} from "./types";

export const G = 9.81;
export const HMIN = 5e-4; // faces shallower than this carry no flow (m)
export const THETA = 0.8; // de Almeida smoothing weight
export const COURANT = 0.8; // 2-D limit with θ = 0.8 smoothing is √θ ≈ 0.89 (de Almeida et al. 2012; Deluge §3.6)
export const UMAX = 6; // velocity cap (m/s), robust mode
export const FROUDE_MAX = 3;
export const DT_MAX = 4;
/**
 * The timestep follows the fastest wave up to C_CLIP (≈ 0.5 m of water moving at 1 m/s). Faces faster
 * than that — deep, still ponds and basins — take their momentum update with dt·(Cr_guard/Cr)², the
 * local Courant guard of Deluge §3.2. The product of the two half-steps then stays inside the
 * stability limit, so ponds stay stable without holding the whole town to their tiny timestep.
 */
export const C_CLIP = 3.0;
export const CR_GUARD = 0.85;
export const BOUNDARY_MIN_SLOPE = 5e-4;
export const WEIR_C = 1.7; // broad-crested weir, Q = C·L·H^1.5 (SI)
export const ORIFICE_CD = 0.6;
export const EMPTY_LEVEL = 0.01; // a square counts as empty below 1 cm
const SQRT_G = Math.sqrt(G);

/** hf^(7/3) from a table in s = √hf (s^(14/3)); exact above the table. ~0.2 % error at 1 mm. */
const POW_N = 4096;
const POW_SMAX = 2; // hf up to 4 m
const POW_TAB = new Float64Array(POW_N + 2);
for (let k = 0; k <= POW_N + 1; k++) POW_TAB[k] = Math.pow((k / POW_N) * POW_SMAX, 14 / 3);
/** 1 / hf^(7/3), the friction factor's depth term. */
function ipow73(hf: number, sh: number): number {
  if (sh >= POW_SMAX) return 1 / (hf * hf * Math.cbrt(hf));
  const x = sh * (POW_N / POW_SMAX);
  const k = x | 0;
  const v = POW_TAB[k] + (POW_TAB[k + 1] - POW_TAB[k]) * (x - k);
  return 1 / v;
}

/** Manning n per land class (Chow 1959; HEC-RAS 2D manual ranges). */
const MANNING: Record<number, number> = {
  [Land.Open]: 0.035,
  [Land.Road]: 0.016,
  [Land.Building]: 0.1,
  [Land.Green]: 0.04,
  [Land.Water]: 0.03,
  [Land.Channel]: 0.015,
  [Land.Paved]: 0.018,
};

/** Infiltration kinds per cell. */
const INF_NONE = 0;
const INF_SOIL = 1; // Horton: f = fc + (f0 − fc)·exp(−F/Fk)
const INF_STORE = 2; // permeable paving / rain garden: into an underground store

/** Horton parameters (m/s and m) for Klang's clayey alluvium. */
const SOIL = {
  [Land.Green]: { f0: 40 / 3.6e6, fc: 5 / 3.6e6, Fk: 0.015 },
  [Land.Open]: { f0: 20 / 3.6e6, fc: 2 / 3.6e6, Fk: 0.01 },
};

/** Underground stores (rate into the store, store depth as water, rate out to the native soil). */
export const STORE = {
  permeable: { fIn: 300 / 3.6e6, sMax: 0.3 * 0.35, fOut: 2 / 3.6e6, n: 0.016 }, // 300 mm sub-base, 35 % voids
  garden: { fIn: 100 / 3.6e6, sMax: 0.6 * 0.3 + 0.3 * 0.4, fOut: 3 / 3.6e6, n: 0.05 }, // soil + gravel layers
};

export interface SquareNode {
  f: RectFeature;
  cells: Int32Array;
  rim: Int32Array; // open cells sharing an edge with the footprint (one entry per shared edge)
  area: number;
  floor: number;
  V: number;
  peakV: number;
  Vmax: number;
  outletArea: number;
  inflowAcc: number;
  outflowAcc: number;
  expectedAcc: number;
  lastExpected: number;
  lastInflow: number;
  lastOutflow: number;
  emptyAt: number | null;
  everFilled: boolean;
}

export interface CellFeature {
  f: Feature;
  cells: Int32Array;
  capacity: number;
  peak: number;
  captured: number;
  /** inlets/drains: index of the square they feed, -1 = drain network */
  target: number;
  capPerCell: number;
}

export function cellsInRect(grid: { nx: number; ny: number; dx: number }, f: RectFeature): number[] {
  const { nx, ny, dx } = grid;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const r = Math.hypot(f.w, f.l) / 2;
  const i0 = Math.max(0, Math.floor((f.cx - r) / dx));
  const i1 = Math.min(nx - 1, Math.ceil((f.cx + r) / dx));
  const j0 = Math.max(0, Math.floor((f.cy - r) / dx));
  const j1 = Math.min(ny - 1, Math.ceil((f.cy + r) / dx));
  const out: number[] = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = (i + 0.5) * dx - f.cx;
      const py = (j + 0.5) * dx - f.cy;
      const u = px * c + py * s;
      const v = -px * s + py * c;
      if (Math.abs(u) <= f.w / 2 && Math.abs(v) <= f.l / 2) out.push(j * nx + i);
    }
  }
  return out;
}

export function cellsOnLine(grid: { nx: number; ny: number; dx: number }, pts: [number, number][]): number[] {
  const { nx, ny, dx } = grid;
  const set = new Set<number>();
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[k + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / (dx * 0.4)));
    for (let s = 0; s <= n; s++) {
      const x = x0 + ((x1 - x0) * s) / n;
      const y = y0 + ((y1 - y0) * s) / n;
      const i = Math.floor(x / dx);
      const j = Math.floor(y / dx);
      if (i >= 0 && j >= 0 && i < nx && j < ny) set.add(j * nx + i);
    }
  }
  return [...set];
}

function distToRect(f: RectFeature, x: number, y: number): number {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const px = x - f.cx;
  const py = y - f.cy;
  const u = Math.abs(px * c + py * s) - f.w / 2;
  const v = Math.abs(-px * s + py * c) - f.l / 2;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0));
}

export class FloodModel {
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly N: number;
  readonly A: number;
  readonly storm: StormSpec;
  readonly params: ModelParams;
  readonly grid: GridData;

  t = 0;
  dt = 0.5;
  readonly tEnd: number;
  cmax = 1;

  zb: Float64Array;
  blocked: Uint8Array;
  h: Float64Array;
  hPeak: Float32Array;
  qx: Float64Array;
  qy: Float64Array;
  private fx: Float64Array;
  private fy: Float64Array;
  private kLim: Float64Array;
  private bW: Float64Array; // outward boundary flux, west edge (per row)
  private bN: Float64Array; // outward boundary flux, north edge (per column)
  n2: Float64Array;
  spout: Float64Array;
  infKind: Uint8Array;
  f0: Float64Array;
  fc: Float64Array;
  Fk: Float64Array;
  F: Float64Array;
  S: Float64Array;
  sMax: Float64Array;
  fIn: Float64Array;
  fOut: Float64Array;
  private rate: Float64Array;
  roadCells: Int32Array;
  roadCap: number; // per road cell inlet capacity, m/s (depth rate)
  private demand: Float64Array;
  netBase: number; // m³/s
  netUser: number; // m³/s of new pipes to the network
  /** Square footprint index per cell, -1 none. */
  readonly squareOf: Int16Array;
  readonly squares: SquareNode[] = [];
  cellFeatures: CellFeature[] = [];
  private bRim: { off: Int32Array; cells: Int32Array };
  roofOnlyRain = 0; // number of cells whose rain is redistributed (for booking)

  // ledger, all m³
  vRain = 0;
  vInitial = 0;
  vInfiltrated = 0;
  vDrained = 0;
  vLeft = 0;
  /** Rounding repairs (should stay ~0). */
  vFixed = 0;

  peakStreet = 0;
  peakRoadArea = 0;
  peakBuildings = 0;
  stepCount = 0;

  constructor(grid: GridData, features: Feature[], storm: StormSpec, params: ModelParams) {
    this.grid = grid;
    this.storm = storm;
    this.params = params;
    const { nx, ny, dx } = grid;
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    const N = (this.N = nx * ny);
    this.A = dx * dx;
    this.tEnd = (storm.durationMin + params.afterMin) * 60;

    this.zb = Float64Array.from(grid.z);
    this.blocked = new Uint8Array(N);
    this.h = new Float64Array(N);
    this.hPeak = new Float32Array(N);
    this.qx = new Float64Array(N);
    this.qy = new Float64Array(N);
    this.fx = new Float64Array(N);
    this.fy = new Float64Array(N);
    this.kLim = new Float64Array(N);
    this.bW = new Float64Array(ny);
    this.bN = new Float64Array(nx);
    this.n2 = new Float64Array(N);
    this.spout = new Float64Array(N);
    this.infKind = new Uint8Array(N);
    this.f0 = new Float64Array(N);
    this.fc = new Float64Array(N);
    this.Fk = new Float64Array(N).fill(1);
    this.F = new Float64Array(N);
    this.S = new Float64Array(N);
    this.sMax = new Float64Array(N);
    this.fIn = new Float64Array(N);
    this.fOut = new Float64Array(N);
    this.rate = new Float64Array(N);
    this.squareOf = new Int16Array(N).fill(-1);
    this.demand = new Float64Array(N);

    const land = grid.land;
    for (let c = 0; c < N; c++) {
      const L = land[c];
      const n = MANNING[L] ?? 0.035;
      this.n2[c] = n * n;
      if (L === Land.Building) this.blocked[c] = 1;
      if (L === Land.Green || L === Land.Open) {
        const s = SOIL[L];
        this.infKind[c] = INF_SOIL;
        this.f0[c] = s.f0;
        this.fc[c] = s.fc;
        this.Fk[c] = s.Fk;
      }
      this.h[c] = L === Land.Building ? 0 : grid.h0[c];
    }

    // ── Design features ────────────────────────────────────────────────────────────────────
    const rects = features.filter((f): f is RectFeature => f.kind === "square" || f.kind === "garden" || f.kind === "permeable");
    // Permeable first, then gardens, then squares, so later (bigger) interventions win overlaps.
    const order = { permeable: 0, garden: 1, square: 2 } as const;
    rects.sort((a, b) => order[a.kind] - order[b.kind]);
    for (const f of rects) {
      const cells = cellsInRect(grid, f).filter((c) => land[c] !== Land.Building && (f.kind !== "square" || land[c] !== Land.Road));
      if (!cells.length) continue;
      if (f.kind === "square") {
        let zsum = 0;
        for (const c of cells) zsum += grid.z[c];
        const ground = zsum / cells.length;
        const idx = this.squares.length;
        for (const c of cells) {
          this.blocked[c] = 1;
          this.squareOf[c] = idx;
          this.h[c] = 0;
          this.infKind[c] = INF_NONE;
        }
        const area = cells.length * this.A;
        const d = f.outletD ?? 0.2;
        this.squares.push({
          f,
          cells: Int32Array.from(cells),
          rim: new Int32Array(0),
          area,
          floor: ground - f.depth,
          V: 0,
          peakV: 0,
          Vmax: area * f.depth,
          outletArea: (Math.PI * d * d) / 4,
          inflowAcc: 0,
          outflowAcc: 0,
          expectedAcc: 0,
          lastExpected: 0,
          lastInflow: 0,
          lastOutflow: 0,
          emptyAt: null,
          everFilled: false,
        });
      } else {
        const st = f.kind === "garden" ? STORE.garden : STORE.permeable;
        let cap = 0;
        for (const c of cells) {
          if (this.squareOf[c] >= 0) continue;
          if (f.kind === "garden") this.zb[c] -= f.depth;
          this.infKind[c] = INF_STORE;
          this.sMax[c] = st.sMax;
          this.fIn[c] = st.fIn;
          this.fOut[c] = st.fOut;
          this.n2[c] = st.n * st.n;
          cap += (st.sMax + (f.kind === "garden" ? f.depth : 0)) * this.A;
        }
        this.cellFeatures.push({ f, cells: Int32Array.from(cells), capacity: cap, peak: 0, captured: 0, target: -1, capPerCell: 0 });
      }
    }

    // Square rims: every open neighbour across each footprint edge.
    for (const sq of this.squares) {
      const rim: number[] = [];
      for (const c of sq.cells) {
        const i = c % nx;
        const j = (c / nx) | 0;
        if (i > 0 && !this.blocked[c - 1]) rim.push(c - 1);
        if (i < nx - 1 && !this.blocked[c + 1]) rim.push(c + 1);
        if (j > 0 && !this.blocked[c - nx]) rim.push(c - nx);
        if (j < ny - 1 && !this.blocked[c + nx]) rim.push(c + nx);
      }
      sq.rim = Int32Array.from(rim);
    }

    // Drains and inlets: capture water and send it to a square (if they reach one) or the network.
    this.netUser = 0;
    for (const f of features) {
      if (f.kind !== "drain" && f.kind !== "inlet") continue;
      const cells = (f.kind === "drain" ? cellsOnLine(grid, f.pts) : cellsOnLine(grid, [[f.x, f.y], [f.x, f.y]])).filter(
        (c) => !this.blocked[c],
      );
      if (!cells.length) continue;
      const ends: [number, number][] = f.kind === "drain" ? [f.pts[0], f.pts[f.pts.length - 1]] : [[f.x, f.y]];
      let target = -1;
      let best = f.kind === "drain" ? 12 : 25;
      this.squares.forEach((sq, k) => {
        for (const [x, y] of ends) {
          const d = distToRect(sq.f, x, y);
          if (d < best) {
            best = d;
            target = k;
          }
        }
      });
      const total = f.kind === "drain" ? f.capacityPerM * cells.length * dx : f.capacity;
      const capPerCell = total / cells.length;
      if (target < 0) this.netUser += total;
      this.cellFeatures.push({ f, cells: Int32Array.from(cells), capacity: 0, peak: 0, captured: 0, target, capPerCell });
    }

    // Roads keep their roadside drains.
    const roads: number[] = [];
    for (let c = 0; c < N; c++) if (land[c] === Land.Road && !this.blocked[c]) roads.push(c);
    // No mapped streets (OpenStreetMap unavailable): treat open ground as the street surface, so the
    // drains still work and the street readouts measure the water people would walk through.
    if (!roads.length) for (let c = 0; c < N; c++) if (!this.blocked[c] && (land[c] === Land.Open || land[c] === Land.Paved)) roads.push(c);
    this.roadCells = Int32Array.from(roads);
    const totalArea = N * this.A;
    this.netBase = (params.drainMmPerHour / 1000 / 3600) * totalArea;
    // Inlets are generous; the pipes and the outfall are the bottleneck.
    this.roadCap = roads.length ? (3 * this.netBase) / (roads.length * this.A) : 0;

    // Roof rain: downpipes discharge to the drain along the street in front of the house, so each
    // building cell sends its rain to the nearest street (multi-source BFS from road cells). Where an
    // area has no mapped streets it falls back to the nearest open cell.
    for (let c = 0; c < N; c++) this.spout[c] = this.blocked[c] ? 0 : 1;
    {
      const owner = new Int32Array(N).fill(-1);
      const queue = new Int32Array(N);
      let qh = 0;
      let qt = 0;
      let nRoad = 0;
      for (let c = 0; c < N; c++) if (!this.blocked[c] && (land[c] === Land.Road || land[c] === Land.Channel)) nRoad++;
      for (let c = 0; c < N; c++)
        if (!this.blocked[c] && (nRoad === 0 || land[c] === Land.Road || land[c] === Land.Channel)) {
          owner[c] = c;
          queue[qt++] = c;
        }
      while (qh < qt) {
        const c = queue[qh++];
        const i = c % nx;
        const j = (c / nx) | 0;
        const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
        for (const d of nb) {
          if (d < 0 || owner[d] >= 0) continue;
          owner[d] = owner[c];
          queue[qt++] = d;
        }
      }
      for (let c = 0; c < N; c++) {
        if (this.blocked[c] && this.squareOf[c] < 0) {
          if (owner[c] >= 0) this.spout[owner[c]] += 1;
          else this.roofOnlyRain++;
        }
      }
    }

    // Building perimeters (cells that touch a building) for the flooded-building count.
    {
      const lists: number[][] = Array.from({ length: grid.nBuildings }, () => []);
      for (let c = 0; c < N; c++) {
        if (this.blocked[c]) continue;
        const i = c % nx;
        const j = (c / nx) | 0;
        const seen = new Set<number>();
        const check = (d: number) => {
          const b = grid.buildingId[d];
          if (b >= 0 && !seen.has(b)) {
            seen.add(b);
            lists[b].push(c);
          }
        };
        if (i > 0) check(c - 1);
        if (i < nx - 1) check(c + 1);
        if (j > 0) check(c - nx);
        if (j < ny - 1) check(c + nx);
      }
      const off = new Int32Array(grid.nBuildings + 1);
      for (let b = 0; b < grid.nBuildings; b++) off[b + 1] = off[b] + lists[b].length;
      const cells = new Int32Array(off[grid.nBuildings]);
      for (let b = 0; b < grid.nBuildings; b++) cells.set(lists[b], off[b]);
      this.bRim = { off, cells };
    }

    let v0 = 0;
    for (let c = 0; c < N; c++) v0 += this.h[c];
    this.vInitial = v0 * this.A;
  }

  /** Fraction of drain-network capacity available at time t (tide backs up the outfalls). */
  tideFactor(t: number): number {
    if (!this.storm.highTide) return 1;
    const tf = this.params.tideFactor;
    const D = this.storm.durationMin * 60;
    // High water through the storm and one hour after, then the tide falls over two hours.
    const t1 = D + 3600;
    const t2 = t1 + 7200;
    if (t <= t1) return tf;
    if (t >= t2) return 1;
    return tf + ((1 - tf) * (t - t1)) / (t2 - t1);
  }

  get done(): boolean {
    return this.t >= this.tEnd - 1e-6;
  }

  get raining(): boolean {
    return this.t < this.storm.durationMin * 60;
  }

  /** Advance one adaptive step. */
  step(): void {
    const { nx, ny, dx, N, A } = this;
    const zb = this.zb;
    const h = this.h;
    const qx = this.qx;
    const qy = this.qy;
    const fx = this.fx;
    const fy = this.fy;
    const blk = this.blocked;
    const n2 = this.n2;

    // ── timestep ──────────────────────────────────────────────────────────────────────────
    let c0 = Math.min(this.cmax, C_CLIP);
    if (this.raining) c0 = Math.max(c0, 1.0);
    let dt = (COURANT * dx) / (Math.SQRT2 * Math.max(c0, 0.05));
    dt = Math.min(dt, DT_MAX, this.tEnd - this.t);
    if (dt <= 0) return;
    this.dt = dt;
    const gdt = G * dt;
    let cmax = 0;

    // ── momentum: x faces ────────────────────────────────────────────────────────────────
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx - 1; i++) {
        const c = row + i;
        const e = c + 1;
        if (blk[c] | blk[e]) {
          fx[c] = 0;
          continue;
        }
        const zc = zb[c];
        const ze = zb[e];
        const ec = zc + h[c];
        const ee = ze + h[e];
        const hf = (ec > ee ? ec : ee) - (zc > ze ? zc : ze);
        if (hf < HMIN) {
          fx[c] = 0;
          continue;
        }
        const S = (ee - ec) / dx;
        const q = qx[c];
        const qW = i > 0 && qx[c - 1] !== 0 ? qx[c - 1] : q;
        const qE = i < nx - 2 && qx[e] !== 0 ? qx[e] : q;
        const qt = THETA * q + (1 - THETA) * 0.5 * (qW + qE);
        const qp = j > 0 ? 0.25 * (qy[c] + qy[e] + qy[c - nx] + qy[e - nx]) : 0.5 * (qy[c] + qy[e]);
        const qmag = Math.sqrt(q * q + qp * qp);
        const sh = Math.sqrt(hf);
        const cw = SQRT_G * sh;
        // local Courant guard (see C_CLIP)
        const uf = qmag / hf;
        const cr = (Math.SQRT2 * (cw + (uf < UMAX ? uf : UMAX)) * dt) / dx;
        const gd = cr > CR_GUARD ? gdt * (CR_GUARD / cr) * (CR_GUARD / cr) : gdt;
        let qn = (qt - gd * hf * S) / (1 + gd * 0.5 * (n2[c] + n2[e]) * qmag * ipow73(hf, sh));
        const fc = FROUDE_MAX * cw;
        const cap = hf * (UMAX < fc ? UMAX : fc);
        if (qn > cap) qn = cap;
        else if (qn < -cap) qn = -cap;
        fx[c] = qn;
        const aq = qn < 0 ? -qn : qn;
        if (cw + aq / hf > cmax) cmax = cw + aq / hf;
      }
    }
    // ── momentum: y faces ────────────────────────────────────────────────────────────────
    for (let j = 0; j < ny - 1; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        const s = c + nx;
        if (blk[c] | blk[s]) {
          fy[c] = 0;
          continue;
        }
        const zc = zb[c];
        const zs = zb[s];
        const ec = zc + h[c];
        const es = zs + h[s];
        const hf = (ec > es ? ec : es) - (zc > zs ? zc : zs);
        if (hf < HMIN) {
          fy[c] = 0;
          continue;
        }
        const S = (es - ec) / dx;
        const q = qy[c];
        const qN = j > 0 && qy[c - nx] !== 0 ? qy[c - nx] : q;
        const qS = j < ny - 2 && qy[s] !== 0 ? qy[s] : q;
        const qt = THETA * q + (1 - THETA) * 0.5 * (qN + qS);
        const qp = i > 0 ? 0.25 * (qx[c] + qx[c - 1] + qx[s] + qx[s - 1]) : 0.5 * (qx[c] + qx[s]);
        const qmag = Math.sqrt(q * q + qp * qp);
        const sh = Math.sqrt(hf);
        const cw = SQRT_G * sh;
        // local Courant guard (see C_CLIP)
        const uf = qmag / hf;
        const cr = (Math.SQRT2 * (cw + (uf < UMAX ? uf : UMAX)) * dt) / dx;
        const gd = cr > CR_GUARD ? gdt * (CR_GUARD / cr) * (CR_GUARD / cr) : gdt;
        let qn = (qt - gd * hf * S) / (1 + gd * 0.5 * (n2[c] + n2[s]) * qmag * ipow73(hf, sh));
        const fc = FROUDE_MAX * cw;
        const cap = hf * (UMAX < fc ? UMAX : fc);
        if (qn > cap) qn = cap;
        else if (qn < -cap) qn = -cap;
        fy[c] = qn;
        const aq = qn < 0 ? -qn : qn;
        if (cw + aq / hf > cmax) cmax = cw + aq / hf;
      }
    }

    // ── open boundaries: outflow only, normal flow capped at critical ────────────────────
    const bflux = (c: number, inner: number) => {
      const hc = h[c];
      if (blk[c] || hc < HMIN) return 0;
      const S = Math.max((zb[inner] - zb[c]) / dx, BOUNDARY_MIN_SLOPE);
      const q = (Math.pow(hc, 5 / 3) * Math.sqrt(S)) / Math.sqrt(n2[c]);
      return Math.min(q, hc * Math.sqrt(G * hc));
    };
    const bW = this.bW;
    const bN = this.bN;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      bW[j] = bflux(row, row + 1);
      fx[row + nx - 1] = bflux(row + nx - 1, row + nx - 2);
    }
    for (let i = 0; i < nx; i++) {
      bN[i] = bflux(i, i + nx);
      fy[(ny - 1) * nx + i] = bflux((ny - 1) * nx + i, (ny - 2) * nx + i);
    }

    // ── positivity limiter factor: no cell exports more than it holds ────────────────────
    const r = dt / dx;
    const kL = this.kLim;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        if (blk[c]) {
          kL[c] = 1;
          continue;
        }
        const hc = h[c];
        const qE = fx[c];
        const qW = i > 0 ? fx[c - 1] : -bW[j];
        const qS = fy[c];
        const qN = j > 0 ? fy[c - nx] : -bN[i];
        const out = r * ((qE > 0 ? qE : 0) + (qW < 0 ? -qW : 0) + (qS > 0 ? qS : 0) + (qN < 0 ? -qN : 0));
        kL[c] = out > hc ? (hc * (1 - 1e-12)) / out : 1;
      }
    }
    for (let j = 0; j < ny; j++) bW[j] *= kL[j * nx];
    for (let i = 0; i < nx; i++) bN[i] *= kL[i];

    // ── continuity (limiting each face by its donor as we go) + rain + soaking in ────────
    // Raster order: the west and north faces of c were limited when their owners were visited.
    const dR = rainDepth(this.storm, this.t, this.t + dt);
    let left = 0;
    let infil = 0;
    let fixed = 0;
    const infKind = this.infKind;
    const hPeak = this.hPeak;
    const spout = this.spout;
    const Fa = this.F;
    const f0a = this.f0;
    const fca = this.fc;
    const Fka = this.Fk;
    const Sa = this.S;
    const sMaxa = this.sMax;
    const fIna = this.fIn;
    const fOuta = this.fOut;
    const rateA = this.rate;
    const refresh = (this.stepCount & 3) === 0;
    const lastRow = ny - 1;
    const lastCol = nx - 1;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        const kc = kL[c];
        let qE = fx[c];
        if (i === lastCol || qE > 0) qE *= kc;
        else if (qE < 0) qE *= kL[c + 1];
        fx[c] = qE;
        let qS = fy[c];
        if (j === lastRow || qS > 0) qS *= kc;
        else if (qS < 0) qS *= kL[c + nx];
        fy[c] = qS;
        if (blk[c]) continue;
        const qW = i > 0 ? fx[c - 1] : -bW[j];
        const qN = j > 0 ? fy[c - nx] : -bN[i];
        let hn = h[c] + r * (qW - qE + qN - qS);
        if (i === 0) left += bW[j];
        if (i === lastCol) left += qE;
        if (j === 0) left += bN[i];
        if (j === lastRow) left += qS;
        if (hn < 0) {
          // Only rounding can reach here (the limiter keeps outflow below the depth); booked as inflow.
          fixed -= hn;
          hn = 0;
        }
        hn += dR * spout[c];
        const k = infKind[c];
        if (k !== INF_NONE && hn > 0) {
          if (k === INF_SOIL) {
            // Horton-type decline with wetting, hyperbolic form: f = fc + (f0 − fc) / (1 + F/Fk),
            // refreshed every 4th step (F changes slowly).
            if (refresh) rateA[c] = fca[c] + (f0a[c] - fca[c]) / (1 + Fa[c] / Fka[c]);
            const cap = rateA[c] * dt;
            const d = hn < cap ? hn : cap;
            hn -= d;
            Fa[c] += d;
            infil += d;
          } else {
            const room = sMaxa[c] - Sa[c];
            const d = Math.min(hn, fIna[c] * dt, room > 0 ? room : 0);
            hn -= d;
            Sa[c] += d;
          }
        }
        if (k === INF_STORE && Sa[c] > 0) {
          const d = Math.min(Sa[c], fOuta[c] * dt);
          Sa[c] -= d;
          infil += d;
        }
        h[c] = hn;
        if (hn > hPeak[c]) hPeak[c] = hn;
      }
    }
    this.vLeft += left * dt * dx;
    this.vInfiltrated += infil * A;
    this.vRain += dR * (N - this.roofOnlyRain) * A;
    this.vFixed += fixed * A;

    // ── drains: roadside inlets + new inlets → network; or → water squares ──────────────
    const tide = this.tideFactor(this.t);
    let netCap = (this.netBase + this.netUser) * tide * dt; // m³ this step
    const dem = this.demand;
    let total = 0;
    // Drains and inlets that reach a square pour straight in: no network limit.
    for (const cf of this.cellFeatures) {
      if (cf.capPerCell <= 0 || cf.target < 0) continue;
      const capD = (cf.capPerCell * dt) / A;
      const sq = this.squares[cf.target];
      // a full court cannot take more: the gutter backs up and the water stays in the street
      let room = Math.max(0, sq.Vmax - sq.V) / A;
      let got = 0;
      for (let k = 0; k < cf.cells.length && room > 0; k++) {
        const c = cf.cells[k];
        let d = h[c] < capD ? h[c] : capD;
        if (d > room) d = room;
        h[c] -= d;
        got += d;
        room -= d;
      }
      sq.V += got * A;
      sq.inflowAcc += got * A;
      cf.captured += got * A;
    }
    const roads = this.roadCells;
    const capRoad = this.roadCap * dt;
    for (let k = 0; k < roads.length; k++) {
      const c = roads[k];
      const d = h[c] < capRoad ? h[c] : capRoad;
      dem[c] = d;
      total += d;
    }
    const netFeatures: CellFeature[] = [];
    for (const cf of this.cellFeatures) {
      if (cf.capPerCell <= 0 || cf.target >= 0) continue;
      const capD = (cf.capPerCell * dt) / A;
      netFeatures.push(cf);
      for (let k = 0; k < cf.cells.length; k++) {
        const c = cf.cells[k];
        const d = Math.min(h[c] - dem[c], capD);
        if (d > 0) {
          dem[c] += d;
          total += d;
        }
      }
    }
    const totalV = total * A;
    const scale = totalV > netCap ? netCap / totalV : 1;
    let drained = 0;
    for (let k = 0; k < roads.length; k++) {
      const c = roads[k];
      const d = dem[c] * scale;
      h[c] -= d;
      drained += d;
      dem[c] = 0;
    }
    for (const cf of netFeatures) {
      let got = 0;
      for (let k = 0; k < cf.cells.length; k++) {
        const c = cf.cells[k];
        const d = dem[c] * scale;
        if (d > 0) {
          h[c] -= d;
          drained += d;
          got += d;
        }
        dem[c] = 0;
      }
      cf.captured += got * A;
    }
    drained *= A;
    netCap = Math.max(0, netCap - drained);

    // ── water squares: rain, weir exchange over the rim, outlet ─────────────────────────
    for (const sq of this.squares) {
      sq.V += dR * sq.cells.length * A;
      const As = sq.area;
      const rim = sq.rim;
      let inflow = 0;
      for (let k = 0; k < rim.length; k++) {
        const c = rim[k];
        const crest = zb[c];
        const hc = h[c];
        const eta = crest + hc;
        const ws = sq.floor + sq.V / As;
        const eq = (A * As) / (A + As);
        if (eta > ws && hc > HMIN) {
          const Hu = hc;
          const Hd = ws > crest ? ws - crest : 0;
          let Q = WEIR_C * dx * Hu * Math.sqrt(Hu);
          if (Hd > 0) Q *= Math.pow(1 - Math.pow(Hd / Hu, 1.5), 0.385);
          const dv = Math.min(Q * dt, hc * A, (eta - ws) * eq);
          h[c] -= dv / A;
          sq.V += dv;
          inflow += dv;
        } else if (ws > eta && ws > crest) {
          const Hu = ws - crest;
          const Hd = hc;
          let Q = WEIR_C * dx * Hu * Math.sqrt(Hu);
          if (Hd > 0) Q *= Math.pow(1 - Math.pow(Math.min(Hd / Hu, 1), 1.5), 0.385);
          const dv = Math.min(Q * dt, sq.V, (ws - eta) * eq);
          sq.V -= dv;
          h[c] += dv / A;
          inflow -= dv;
        }
      }
      sq.inflowAcc += inflow;
      // Outlet pipe at the floor, into whatever network capacity is left.
      const head = sq.V / As;
      const clear = 1 - this.params.clog;
      const Qo = ORIFICE_CD * sq.outletArea * Math.sqrt(2 * G * head) * clear;
      const out = Math.min(sq.V, Qo * dt, netCap);
      sq.expectedAcc += Math.min(sq.V, (clear > 0 ? Qo / clear : ORIFICE_CD * sq.outletArea * Math.sqrt(2 * G * head)) * dt, netCap);
      sq.V -= out;
      netCap -= out;
      drained += out;
      sq.outflowAcc += out;
      if (sq.V > sq.peakV) sq.peakV = sq.V;
      if (head > 0.05) sq.everFilled = true;
      if (!this.raining && sq.everFilled && sq.emptyAt === null && sq.V / As < EMPTY_LEVEL) sq.emptyAt = this.t + dt;
    }
    this.vDrained += drained;

    for (const cf of this.cellFeatures) {
      if (cf.f.kind === "garden" || cf.f.kind === "permeable") {
        let v = 0;
        for (let k = 0; k < cf.cells.length; k++) v += this.S[cf.cells[k]] + (cf.f.kind === "garden" ? h[cf.cells[k]] : 0);
        if (v * A > cf.peak) cf.peak = v * A;
      }
    }

    // swap: limited fluxes become the state
    this.qx = fx;
    this.fx = qx;
    this.qy = fy;
    this.fy = qy;
    this.cmax = cmax * 1.1 + 0.05;
    this.t += dt;
    this.stepCount++;
  }

  /** Run steps until sim time reaches t (or the end). Returns steps taken. */
  advanceTo(t: number, maxMs = Infinity): number {
    const start = performance.now();
    let n = 0;
    while (this.t < t - 1e-9 && !this.done) {
      this.step();
      n++;
      if ((n & 15) === 0 && performance.now() - start > maxMs) break;
    }
    return n;
  }

  balance(): Balance {
    const A = this.A;
    let surface = 0;
    let store = 0;
    for (let c = 0; c < this.N; c++) {
      surface += this.h[c];
      store += this.S[c];
    }
    let sq = 0;
    for (const s of this.squares) sq += s.V;
    const surf = surface * A;
    const fs = store * A + sq;
    const inn = this.vRain + this.vInitial + this.vFixed;
    const acc = surf + fs + this.vInfiltrated + this.vDrained + this.vLeft;
    return {
      rain: this.vRain,
      initial: this.vInitial,
      surface: surf,
      featureStore: fs,
      infiltrated: this.vInfiltrated,
      drained: this.vDrained,
      leftArea: this.vLeft,
      error: inn > 0 ? (inn - acc) / inn : 0,
    };
  }

  /** Readouts. `interval` is the sim time since the previous call (for inflow/outflow rates). */
  stats(interval: number, stepsPerSec = 0): Stats {
    const { A, h, grid } = this;
    const thr = 0.15;
    const roads = this.roadCells;
    let maxD = 0;
    let wetRoad = 0;
    const hist = new Uint32Array(301);
    let nWet = 0;
    for (let k = 0; k < roads.length; k++) {
      const d = h[roads[k]];
      if (d > maxD) maxD = d;
      if (d > thr) wetRoad++;
      if (d > 0.01) {
        hist[Math.min(300, Math.round(d * 100))]++;
        nWet++;
      }
    }
    let p95 = 0;
    if (nWet > 0) {
      let acc = 0;
      for (let b = 0; b <= 300; b++) {
        acc += hist[b];
        if (acc >= nWet * 0.95) {
          p95 = b / 100;
          break;
        }
      }
    }
    // Peak road quantities from the running per-cell maxima.
    let peakMax = 0;
    let peakArea = 0;
    for (let k = 0; k < roads.length; k++) {
      const d = this.hPeak[roads[k]];
      if (d > peakMax) peakMax = d;
      if (d > thr) peakArea++;
    }
    this.peakStreet = peakMax;
    this.peakRoadArea = peakArea * A;

    const bthr = this.params.buildingThreshold;
    const { off, cells } = this.bRim;
    let wet = 0;
    let wetPeak = 0;
    for (let b = 0; b < grid.nBuildings; b++) {
      let m = 0;
      let mp = 0;
      for (let k = off[b]; k < off[b + 1]; k++) {
        const c = cells[k];
        if (h[c] > m) m = h[c];
        if (this.hPeak[c] > mp) mp = this.hPeak[c];
      }
      if (m > bthr) wet++;
      if (mp > bthr) wetPeak++;
    }
    this.peakBuildings = wetPeak;

    const feats: FeatureStat[] = [];
    const iv = Math.max(interval, 1e-6);
    for (const sq of this.squares) {
      sq.lastInflow = sq.inflowAcc / iv;
      sq.lastOutflow = sq.outflowAcc / iv;
      sq.inflowAcc = 0;
      sq.outflowAcc = 0;
      sq.lastExpected = sq.expectedAcc / iv;
      sq.expectedAcc = 0;
      const head = sq.V / sq.area;
      const clear = 1 - this.params.clog;
      const k = ORIFICE_CD * sq.outletArea * Math.sqrt(2 * G) * clear;
      const proj = k > 0 ? (2 * sq.area * Math.sqrt(Math.max(head - EMPTY_LEVEL, 0))) / k : null;
      feats.push({
        id: sq.f.id,
        kind: "square",
        name: sq.f.name,
        stored: sq.V,
        peakStored: sq.peakV,
        capacity: sq.Vmax,
        level: head,
        fill: sq.V / sq.Vmax,
        outflow: sq.lastOutflow,
        expectedOutflow: sq.lastExpected,
        inflow: sq.lastInflow,
        emptyAt: sq.emptyAt,
        projectedEmpty: proj,
      });
    }
    for (const cf of this.cellFeatures) {
      const f = cf.f;
      if (f.kind === "garden" || f.kind === "permeable") {
        let v = 0;
        for (let k = 0; k < cf.cells.length; k++) v += this.S[cf.cells[k]] + (f.kind === "garden" ? h[cf.cells[k]] : 0);
        feats.push({ id: f.id, kind: f.kind, name: f.name, stored: v * A, peakStored: cf.peak, capacity: cf.capacity });
      } else {
        feats.push({ id: f.id, kind: f.kind, name: f.name, stored: 0, peakStored: 0, capacity: 0, captured: cf.captured });
      }
    }
    return {
      t: this.t,
      rainRateMmH: rainRate(this.storm, this.t) * 3.6e6,
      raining: this.raining,
      streetDepth: maxD,
      peakStreetDepth: peakMax,
      streetP95: p95,
      floodedRoadArea: wetRoad * A,
      peakFloodedRoadArea: peakArea * A,
      buildingsWet: wet,
      peakBuildingsWet: wetPeak,
      features: feats,
      balance: this.balance(),
      dt: this.dt,
      stepsPerSec,
    };
  }

  /**
   * Depth field for rendering (Float32). Square footprints carry their water level above the floor,
   * so the renderer can draw them against the sunken court.
   */
  depthField(out: Float32Array): void {
    const h = this.h;
    for (let c = 0; c < this.N; c++) out[c] = h[c];
    for (const sq of this.squares) {
      const lv = sq.V / sq.area;
      for (let k = 0; k < sq.cells.length; k++) out[sq.cells[k]] = lv;
    }
  }

  /** Speed |q|/h per cell for foam and arrows (Float32). */
  speedField(out: Float32Array): void {
    const { nx, ny, h, qx, qy } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const d = h[c];
        if (d < 0.005) {
          out[c] = 0;
          continue;
        }
        const ux = 0.5 * (qx[c] + (i > 0 ? qx[c - 1] : 0));
        const uy = 0.5 * (qy[c] + (j > 0 ? qy[c - nx] : 0));
        out[c] = Math.min(4, Math.hypot(ux, uy) / d);
      }
    }
  }

  squareFloors(): { id: string; floor: number; depth: number; cells: number }[] {
    return this.squares.map((s) => ({ id: s.f.id, floor: s.floor, depth: s.f.depth, cells: s.cells.length }));
  }
}
