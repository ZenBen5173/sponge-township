/// <reference types="@webgpu/types" />
/**
 * WebGPU version of FloodModel.step(): the same local-inertial scheme in four compute passes per step —
 * momentum → limiter factor → continuity (+ rain, soaking in, roadside drains) → water squares.
 *
 * FloodModel still does all the set-up, statistics and the water-balance ledger; after each batch of
 * steps the GPU state is read back into it. Integrated GPUs are memory-bound, so per-cell data is packed
 * into two vec4s (cellA: ground, roughness², roof-rain factor, drain-inlet capacity; cellB: soil or
 * store parameters). Two simplifications against the CPU model, both mass-conserving:
 *  - the drain network's share-out uses the previous step's total demand (a one-step lag);
 *  - state is Float32, so the balance closes to ~1e-6 instead of ~1e-14 (every external change is
 *    accumulated per cell and summed in Float64 on the CPU).
 * Falls back to the CPU model wherever WebGPU is missing.
 */
import { BOUNDARY_MIN_SLOPE, C_CLIP, COURANT, CR_GUARD, DT_MAX, EMPTY_LEVEL, FROUDE_MAX, type FloodModel, HMIN, ORIFICE_CD, THETA, UMAX, WEIR_C } from "./model";
import { rainDepth } from "./storm";

const WG = 64;
const STEP_STRIDE = 256; // dynamic uniform offset alignment
const BATCH = 64;
const DEMAND_UNIT = "1e-9"; // fixed-point unit for the atomic drain-demand sum (m of depth)

const COMMON = /* wgsl */ `
struct Consts { nx: u32, ny: u32, n: u32, pad0: u32, dx: f32, A: f32, hmin: f32, theta: f32,
  umax: f32, froude: f32, bminS: f32, crGuard: f32, nSq: u32, nCap: u32, weirC: f32, cd: f32 };
struct Step { dt: f32, dR: f32, r: f32, netCap: f32, t: f32, raining: f32, clear: f32, pad: f32 };
@group(0) @binding(0) var<uniform> K: Consts;
@group(0) @binding(1) var<uniform> P: Step;
const G: f32 = 9.81;
`;

export const MOMENTUM = /* wgsl */ `${COMMON}
@group(1) @binding(0) var<storage, read> cellA: array<vec4<f32>>; // zb, n2 (<0 blocked), spout, inletCap
@group(1) @binding(1) var<storage, read> h: array<f32>;
@group(1) @binding(2) var<storage, read> q: array<vec2<f32>>;
@group(1) @binding(3) var<storage, read_write> f: array<vec2<f32>>;
@group(1) @binding(4) var<storage, read_write> bnd: array<f32>;
@group(1) @binding(5) var<storage, read_write> misc: array<atomic<u32>>;
var<private> spMax: f32 = 0.0;
var<workgroup> wgMax: array<f32, ${WG}>;

fn face(zc: f32, nc: f32, hc: f32, e: u32, qv: f32, qa: f32, qb: f32, qp: f32) -> f32 {
  let ae = cellA[e];
  if (nc < 0.0 || ae.y < 0.0) { return 0.0; }
  let ec = zc + hc; let ee = ae.x + h[e];
  let hf = max(ec, ee) - max(zc, ae.x);
  if (hf < K.hmin) { return 0.0; }
  let S = (ee - ec) / K.dx;
  let qt = K.theta * qv + (1.0 - K.theta) * 0.5 * (qa + qb);
  let qmag = sqrt(qv * qv + qp * qp);
  let sh = sqrt(hf);
  let cw = 3.13209 * sh;
  // local Courant guard: a face faster than the batch's timestep allows advances with a smaller one
  let u = min(qmag / hf, K.umax);
  let cr = 1.41421356 * (cw + u) * P.dt / K.dx;
  let ratio = min(1.0, K.crGuard / max(cr, 1e-6));
  let dtm = P.dt * ratio * ratio;
  let hf73 = hf * hf * pow(hf, 0.33333333);
  var qn = (qt - G * dtm * hf * S) / (1.0 + G * dtm * 0.5 * (nc + ae.y) * qmag / hf73);
  let cap = hf * min(K.umax, K.froude * cw);
  qn = clamp(qn, -cap, cap);
  spMax = max(spMax, cw + abs(qn) / hf);
  return qn;
}

fn bflux(a: vec4<f32>, hc: f32, inner: u32) -> f32 {
  if (a.y < 0.0 || hc < K.hmin) { return 0.0; }
  let S = max((cellA[inner].x - a.x) / K.dx, K.bminS);
  let qn = pow(hc, 1.6666667) * sqrt(S) / sqrt(a.y);
  return min(qn, hc * sqrt(G * hc));
}

fn cellMomentum(c: u32) {
  let nx = K.nx; let ny = K.ny;
  let j = c / nx; let i = c - j * nx;
  let a = cellA[c];
  let hc = h[c];
  let qc = q[c];
  var fe = 0.0;
  var fs = 0.0;
  if (i < nx - 1u) {
    let e = c + 1u;
    let qe = q[e];
    var qa = qc.x; if (i > 0u) { let w = q[c - 1u].x; if (w != 0.0) { qa = w; } }
    var qb = qc.x; if (i < nx - 2u && qe.x != 0.0) { qb = qe.x; }
    var qp = 0.5 * (qc.y + qe.y);
    if (j > 0u) { qp = 0.25 * (qc.y + qe.y + q[c - nx].y + q[e - nx].y); }
    fe = face(a.x, a.y, hc, e, qc.x, qa, qb, qp);
  } else {
    fe = bflux(a, hc, c - 1u);
  }
  if (j < ny - 1u) {
    let s = c + nx;
    let qs = q[s];
    var qa = qc.y; if (j > 0u) { let n = q[c - nx].y; if (n != 0.0) { qa = n; } }
    var qb = qc.y; if (j < ny - 2u && qs.y != 0.0) { qb = qs.y; }
    var qp = 0.5 * (qc.x + qs.x);
    if (i > 0u) { qp = 0.25 * (qc.x + q[c - 1u].x + qs.x + q[s - 1u].x); }
    fs = face(a.x, a.y, hc, s, qc.y, qa, qb, qp);
  } else {
    fs = bflux(a, hc, c - nx);
  }
  f[c] = vec2<f32>(fe, fs);
  if (i == 0u) { bnd[j] = bflux(a, hc, c + 1u); }
  if (j == 0u) { bnd[ny + i] = bflux(a, hc, c + nx); }
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (gid.x < K.n) { cellMomentum(gid.x); }
  // one atomic per workgroup for the fastest wave
  wgMax[li] = spMax;
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s = s >> 1u) {
    if (li < s) { wgMax[li] = max(wgMax[li], wgMax[li + s]); }
    workgroupBarrier();
  }
  if (li == 0u) { atomicMax(&misc[0], bitcast<u32>(wgMax[0])); }
}
`;

export const LIMITER = /* wgsl */ `${COMMON}
@group(1) @binding(0) var<storage, read> cellA: array<vec4<f32>>;
@group(1) @binding(1) var<storage, read> h: array<f32>;
@group(1) @binding(2) var<storage, read> f: array<vec2<f32>>;
@group(1) @binding(3) var<storage, read> bnd: array<f32>;
@group(1) @binding(4) var<storage, read_write> kL: array<f32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= K.n) { return; }
  let nx = K.nx; let j = c / nx; let i = c - j * nx;
  let fc = f[c];
  var qW = -bnd[j]; if (i > 0u) { qW = f[c - 1u].x; }
  var qN = -bnd[K.ny + i]; if (j > 0u) { qN = f[c - nx].y; }
  let out = P.r * (max(fc.x, 0.0) + max(-qW, 0.0) + max(fc.y, 0.0) + max(-qN, 0.0));
  let hc = h[c];
  var k = 1.0;
  if (out > hc) { k = hc * (1.0 - 1e-6) / out; }
  kL[c] = k;
}
`;

export const CONTINUITY = /* wgsl */ `${COMMON}
@group(1) @binding(0) var<storage, read> cellA: array<vec4<f32>>;
@group(1) @binding(1) var<storage, read> cellB: array<vec4<f32>>; // soil: f0, fc, 1/Fk, 1 · store: sMax, fIn, fOut, 2
@group(1) @binding(2) var<storage, read_write> h: array<f32>;
@group(1) @binding(3) var<storage, read_write> q: array<vec2<f32>>;
@group(1) @binding(4) var<storage, read> f: array<vec2<f32>>;
@group(1) @binding(5) var<storage, read> kL: array<f32>;
@group(1) @binding(6) var<storage, read> bnd: array<f32>;
@group(1) @binding(7) var<storage, read_write> st: array<vec2<f32>>;   // F (soil) or S (store), peak depth
@group(1) @binding(8) var<storage, read_write> acc: array<vec4<f32>>;  // store exfiltration, left area, drained, fixed (m)
@group(1) @binding(9) var<storage, read_write> net: array<atomic<u32>>; // [0] demand sum (fixed point), [1] scale bits
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= K.n) { return; }
  let nx = K.nx; let ny = K.ny;
  let j = c / nx; let i = c - j * nx;
  let kc = kL[c];
  let fc = f[c];
  var qE = fc.x;
  if (i == nx - 1u || qE > 0.0) { qE *= kc; } else if (qE < 0.0) { qE *= kL[c + 1u]; }
  var qS = fc.y;
  if (j == ny - 1u || qS > 0.0) { qS *= kc; } else if (qS < 0.0) { qS *= kL[c + nx]; }
  q[c] = vec2<f32>(qE, qS);
  let a = cellA[c];
  if (a.y < 0.0) { return; }
  var qW = -bnd[j] * kc;
  if (i > 0u) { let v = f[c - 1u].x; if (v > 0.0) { qW = v * kL[c - 1u]; } else { qW = v * kc; } }
  var qN = -bnd[ny + i] * kc;
  if (j > 0u) { let v = f[c - nx].y; if (v > 0.0) { qN = v * kL[c - nx]; } else { qN = v * kc; } }
  var hn = h[c] + P.r * (qW - qE + qN - qS);
  var left = 0.0;
  if (i == 0u) { left += bnd[j] * kc; }
  if (i == nx - 1u) { left += qE; }
  if (j == 0u) { left += bnd[ny + i] * kc; }
  if (j == ny - 1u) { left += qS; }
  var fix = 0.0;
  if (hn < 0.0) { fix = -hn; hn = 0.0; }
  hn += P.dR * a.z;
  var s = st[c];
  let b = cellB[c];
  var exf = 0.0;
  if (b.w > 0.5 && hn > 0.0) {
    if (b.w < 1.5) {
      let rate = b.y + (b.x - b.y) / (1.0 + s.x * b.z);
      let d = min(hn, rate * P.dt);
      hn -= d; s.x += d;
    } else {
      let d = min(min(hn, b.y * P.dt), max(b.x - s.x, 0.0));
      hn -= d; s.x += d;
    }
  }
  if (b.w > 1.5 && s.x > 0.0) {
    exf = min(s.x, b.z * P.dt);
    s.x -= exf;
  }
  // roadside drain inlet: take this step's share (scale from last step's demand) and book the demand
  var drained = 0.0;
  if (a.w > 0.0) {
    let d = min(hn, a.w * P.dt);
    drained = d * bitcast<f32>(atomicLoad(&net[1]));
    hn -= drained;
    atomicAdd(&net[0], u32(d / ${DEMAND_UNIT}));
  }
  h[c] = hn;
  s.y = max(s.y, hn);
  st[c] = s;
  if (left != 0.0 || fix != 0.0 || exf != 0.0 || drained != 0.0) {
    var ac = acc[c];
    ac += vec4<f32>(exf, left * P.r, drained, fix);
    acc[c] = ac;
  }
}
`;

// Squares and the drain-network share-out: one invocation (there are few squares and capture cells).
const SQUARES = /* wgsl */ `${COMMON}
struct Sq { V: f32, peakV: f32, floor: f32, area: f32, outletA: f32, Vmax: f32, rimOff: u32, rimN: u32,
  cellN: u32, emptyAt: f32, everFilled: f32, pad: f32 };
@group(1) @binding(0) var<storage, read> cellA: array<vec4<f32>>;
@group(1) @binding(1) var<storage, read_write> h: array<f32>;
@group(1) @binding(2) var<storage, read_write> sq: array<Sq>;
@group(1) @binding(3) var<storage, read> rim: array<u32>;
@group(1) @binding(4) var<storage, read> caps: array<vec4<u32>>; // cell, rate (m³/s, f32 bits), square, feature
@group(1) @binding(5) var<storage, read_write> featCap: array<f32>;
@group(1) @binding(6) var<storage, read_write> net: array<atomic<u32>>;
@group(1) @binding(7) var<storage, read_write> sqAcc: array<vec4<f32>>; // inflow, outflow, expected (m³)
@compute @workgroup_size(1)
fn main() {
  let A = K.A;
  // drain network: this step's demand sets next step's share; what is left feeds the square outlets
  let demand = f32(atomicLoad(&net[0])) * ${DEMAND_UNIT} * A;
  let scaleNow = bitcast<f32>(atomicLoad(&net[1]));
  var netLeft = max(P.netCap - demand * scaleNow, 0.0);
  var sc = 1.0;
  if (demand > P.netCap) { sc = P.netCap / demand; }
  atomicStore(&net[1], bitcast<u32>(sc));
  atomicStore(&net[0], 0u);
  for (var k = 0u; k < K.nCap; k++) {
    let e = caps[k];
    // a full court cannot take more: the gutter backs up and the water stays in the street
    let room = max(sq[e.z].Vmax - sq[e.z].V, 0.0) / A;
    let d = min(min(h[e.x], bitcast<f32>(e.y) * P.dt / A), room);
    h[e.x] -= d;
    sq[e.z].V += d * A;
    sqAcc[e.z].x += d * A;
    featCap[e.w] += d * A;
  }
  for (var s = 0u; s < K.nSq; s++) {
    var Q = sq[s];
    Q.V += P.dR * f32(Q.cellN) * A;
    var inflow = 0.0;
    let eq = (A * Q.area) / (A + Q.area);
    for (var k = 0u; k < Q.rimN; k++) {
      let c = rim[Q.rimOff + k];
      let crest = cellA[c].x;
      let hc = h[c];
      let eta = crest + hc;
      let ws = Q.floor + Q.V / Q.area;
      if (eta > ws && hc > K.hmin) {
        let Hu = hc;
        let Hd = max(ws - crest, 0.0);
        var Qw = K.weirC * K.dx * Hu * sqrt(Hu);
        if (Hd > 0.0) { Qw *= pow(1.0 - pow(Hd / Hu, 1.5), 0.385); }
        let dv = min(min(Qw * P.dt, hc * A), (eta - ws) * eq);
        h[c] = hc - dv / A;
        Q.V += dv;
        inflow += dv;
      } else if (ws > eta && ws > crest) {
        let Hu = ws - crest;
        let Hd = hc;
        var Qw = K.weirC * K.dx * Hu * sqrt(Hu);
        if (Hd > 0.0) { Qw *= pow(1.0 - pow(min(Hd / Hu, 1.0), 1.5), 0.385); }
        let dv = min(min(Qw * P.dt, Q.V), (ws - eta) * eq);
        Q.V -= dv;
        h[c] = hc + dv / A;
        inflow -= dv;
      }
    }
    let head = Q.V / Q.area;
    let qClear = K.cd * Q.outletA * sqrt(2.0 * G * max(head, 0.0));
    let out = min(min(Q.V, qClear * P.clear * P.dt), netLeft);
    let expv = min(min(Q.V, qClear * P.dt), netLeft);
    Q.V -= out;
    netLeft -= out;
    Q.peakV = max(Q.peakV, Q.V);
    if (head > 0.05) { Q.everFilled = 1.0; }
    if (P.raining < 0.5 && Q.everFilled > 0.5 && Q.emptyAt < 0.0 && Q.V / Q.area < ${EMPTY_LEVEL}) { Q.emptyAt = P.t + P.dt; }
    sq[s] = Q;
    var ac = sqAcc[s];
    ac.x += inflow; ac.y += out; ac.z += expv;
    sqAcc[s] = ac;
  }
}
`;

type Kernel = { pipeline: GPUComputePipeline; group1: GPUBindGroup; groups: number };
const READ_BACK = ["h", "q", "st", "acc", "sq", "sqAcc", "featCap"] as const;

export class GpuSolver {
  private cmax = 1;
  private lost = false;
  private staging: Record<string, GPUBuffer> = {};
  private cmaxStaging: GPUBuffer;
  private params = new ArrayBuffer(STEP_STRIDE * BATCH);
  private soilMask: Uint8Array;
  private prevF = 0;

  private constructor(
    readonly m: FloodModel,
    private device: GPUDevice,
    private group0: GPUBindGroup,
    private stepBuf: GPUBuffer,
    private kernels: Kernel[],
    private bufs: Record<string, GPUBuffer>,
  ) {
    for (const n of READ_BACK) this.staging[n] = device.createBuffer({ size: bufs[n].size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.cmaxStaging = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.soilMask = Uint8Array.from(m.infKind, (k) => (k === 1 ? 1 : 0));
    for (let c = 0; c < m.N; c++) if (this.soilMask[c]) this.prevF += m.F[c];
  }

  static async create(m: FloodModel): Promise<GpuSolver | null> {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    // continuity binds ten storage buffers; WebGPU's default per-stage limit is eight
    if (adapter.limits.maxStorageBuffersPerShaderStage < 10) return null;
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 10 } });
    const { nx, ny, N, A, dx } = m;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const mk = (data: ArrayBufferView | number, u = usage) => {
      const size = typeof data === "number" ? data : data.byteLength;
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: u, mappedAtCreation: typeof data !== "number" });
      if (typeof data !== "number") {
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        b.unmap();
      }
      return b;
    };
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    const bits = (v: number) => {
      f32[0] = v;
      return u32[0];
    };

    // per-cell constants, packed
    const cellA = new Float32Array(N * 4);
    const cellB = new Float32Array(N * 4);
    for (let c = 0; c < N; c++) {
      cellA[c * 4] = m.zb[c];
      cellA[c * 4 + 1] = m.blocked[c] ? -1 : m.n2[c];
      cellA[c * 4 + 2] = m.spout[c];
      if (m.infKind[c] === 1) cellB.set([m.f0[c], m.fc[c], 1 / m.Fk[c], 1], c * 4);
      else if (m.infKind[c] === 2) cellB.set([m.sMax[c], m.fIn[c], m.fOut[c], 2], c * 4);
    }
    for (let k = 0; k < m.roadCells.length; k++) cellA[m.roadCells[k] * 4 + 3] += m.roadCap;
    const caps: number[] = [];
    m.cellFeatures.forEach((cf, fi) => {
      if (cf.capPerCell <= 0) return;
      for (const c of cf.cells) {
        if (cf.target >= 0) caps.push(c, bits(cf.capPerCell), cf.target, fi);
        else cellA[c * 4 + 3] += cf.capPerCell / A;
      }
    });
    const nCap = caps.length / 4;
    const rims: number[] = [];
    const sqArr = new ArrayBuffer(Math.max(1, m.squares.length) * 48);
    const sqF = new Float32Array(sqArr);
    const sqU = new Uint32Array(sqArr);
    m.squares.forEach((s, k) => {
      const o = k * 12;
      sqF[o] = s.V;
      sqF[o + 1] = s.peakV;
      sqF[o + 2] = s.floor;
      sqF[o + 3] = s.area;
      sqF[o + 4] = s.outletArea;
      sqF[o + 5] = s.Vmax;
      sqU[o + 6] = rims.length;
      sqU[o + 7] = s.rim.length;
      sqU[o + 8] = s.cells.length;
      sqF[o + 9] = -1;
      for (const c of s.rim) rims.push(c);
    });

    const consts = new ArrayBuffer(64);
    const cu = new Uint32Array(consts);
    const cf = new Float32Array(consts);
    cu[0] = nx;
    cu[1] = ny;
    cu[2] = N;
    cf[4] = dx;
    cf[5] = A;
    cf[6] = HMIN;
    cf[7] = THETA;
    cf[8] = UMAX;
    cf[9] = FROUDE_MAX;
    cf[10] = BOUNDARY_MIN_SLOPE;
    cf[11] = CR_GUARD;
    cu[12] = m.squares.length;
    cu[13] = nCap;
    cf[14] = WEIR_C;
    cf[15] = ORIFICE_CD;

    const st = new Float32Array(N * 2);
    const q = new Float32Array(N * 2);
    for (let c = 0; c < N; c++) {
      st[c * 2] = m.infKind[c] === 2 ? m.S[c] : m.F[c];
      st[c * 2 + 1] = m.hPeak[c];
      q[c * 2] = m.qx[c];
      q[c * 2 + 1] = m.qy[c];
    }
    const net = new Uint32Array([0, bits(1), 0, 0]);
    const bufs: Record<string, GPUBuffer> = {
      consts: mk(new Uint8Array(consts), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      cellA: mk(cellA),
      cellB: mk(cellB),
      h: mk(Float32Array.from(m.h)),
      q: mk(q),
      f: mk(N * 8),
      bnd: mk((nx + ny) * 4),
      misc: mk(16),
      kL: mk(N * 4),
      st: mk(st),
      acc: mk(N * 16),
      net: mk(net),
      sq: mk(new Uint8Array(sqArr)),
      rim: mk(Uint32Array.from(rims.length ? rims : [0])),
      caps: mk(Uint32Array.from(caps.length ? caps : [0, 0, 0, 0])),
      featCap: mk(Math.max(1, m.cellFeatures.length) * 4),
      sqAcc: mk(Math.max(1, m.squares.length) * 16),
    };
    const stepBuf = device.createBuffer({ size: STEP_STRIDE * BATCH, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const g0Layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });
    const group0 = device.createBindGroup({
      layout: g0Layout,
      entries: [
        { binding: 0, resource: { buffer: bufs.consts } },
        { binding: 1, resource: { buffer: stepBuf, size: 32 } },
      ],
    });
    const groups = Math.ceil(N / WG);
    const kernel = (code: string, list: [string, "read-only-storage" | "storage"][], g: number): Kernel => {
      const g1Layout = device.createBindGroupLayout({
        entries: list.map(([, type], k) => ({ binding: k, visibility: GPUShaderStage.COMPUTE, buffer: { type } })),
      });
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [g0Layout, g1Layout] }),
        compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
      });
      const group1 = device.createBindGroup({ layout: g1Layout, entries: list.map(([name], k) => ({ binding: k, resource: { buffer: bufs[name] } })) });
      return { pipeline, group1, groups: g };
    };
    const R = "read-only-storage" as const;
    const W = "storage" as const;
    device.pushErrorScope("validation");
    const kernels = [
      kernel(MOMENTUM, [["cellA", R], ["h", R], ["q", R], ["f", W], ["bnd", W], ["misc", W]], groups),
      kernel(LIMITER, [["cellA", R], ["h", R], ["f", R], ["bnd", R], ["kL", W]], groups),
      kernel(CONTINUITY, [["cellA", R], ["cellB", R], ["h", W], ["q", W], ["f", R], ["kL", R], ["bnd", R], ["st", W], ["acc", W], ["net", W]], groups),
      kernel(SQUARES, [["cellA", R], ["h", W], ["sq", W], ["rim", R], ["caps", R], ["featCap", W], ["net", W], ["sqAcc", W]], 1),
    ];
    const err = await device.popErrorScope();
    if (err) {
      console.warn("WebGPU solver unavailable:", err.message);
      device.destroy();
      return null;
    }
    const solver = new GpuSolver(m, device, group0, stepBuf, kernels, bufs);
    device.lost.then(() => (solver.lost = true));
    return solver;
  }

  get ok() {
    return !this.lost;
  }

  /** Advance to sim time `to`, spending at most ~budgetMs, then read the state back into the model. */
  async advanceTo(to: number, budgetMs: number): Promise<number> {
    const m = this.m;
    const dev = this.device;
    const start = performance.now();
    let steps = 0;
    const pf = new Float32Array(this.params);
    while (m.t < to - 1e-9 && !m.done && performance.now() - start < budgetMs) {
      // one batch at a fixed dt chosen from the last batch's fastest wave (+ the local Courant guard)
      let c0 = Math.min(this.cmax * 1.15 + 0.05, C_CLIP);
      if (m.raining) c0 = Math.max(c0, 1.0);
      const dt0 = Math.min((COURANT * m.dx) / (Math.SQRT2 * Math.max(c0, 0.05)), DT_MAX);
      const D = m.storm.durationMin * 60;
      let t = m.t;
      let n = 0;
      while (n < BATCH && t < to - 1e-9 && t < m.tEnd - 1e-9) {
        const dt = Math.min(dt0, m.tEnd - t);
        const dR = rainDepth(m.storm, t, t + dt);
        const o = (n * STEP_STRIDE) / 4;
        pf[o] = dt;
        pf[o + 1] = dR;
        pf[o + 2] = dt / m.dx;
        pf[o + 3] = (m.netBase + m.netUser) * m.tideFactor(t) * dt;
        pf[o + 4] = t;
        pf[o + 5] = t < D ? 1 : 0;
        pf[o + 6] = 1 - m.params.clog;
        m.vRain += dR * (m.N - m.roofOnlyRain) * m.A;
        t += dt;
        n++;
      }
      if (!n) break;
      dev.queue.writeBuffer(this.stepBuf, 0, this.params, 0, n * STEP_STRIDE);
      const enc = dev.createCommandEncoder();
      enc.clearBuffer(this.bufs.misc);
      const pass = enc.beginComputePass();
      for (let k = 0; k < n; k++) {
        const off = [k * STEP_STRIDE];
        for (const kr of this.kernels) {
          pass.setPipeline(kr.pipeline);
          pass.setBindGroup(0, this.group0, off);
          pass.setBindGroup(1, kr.group1);
          pass.dispatchWorkgroups(kr.groups);
        }
      }
      pass.end();
      enc.copyBufferToBuffer(this.bufs.misc, 0, this.cmaxStaging, 0, 16);
      dev.queue.submit([enc.finish()]);
      await this.cmaxStaging.mapAsync(GPUMapMode.READ);
      this.cmax = new Float32Array(this.cmaxStaging.getMappedRange())[0] || 0;
      this.cmaxStaging.unmap();
      m.dt = dt0;
      m.t = t;
      m.stepCount += n;
      steps += n;
    }
    m.cmax = this.cmax;
    await this.readBack();
    return steps;
  }

  /** Copy GPU state into the FloodModel so its stats, ledger and render fields are current. */
  private async readBack() {
    const m = this.m;
    const dev = this.device;
    const N = m.N;
    const enc = dev.createCommandEncoder();
    for (const n of READ_BACK) enc.copyBufferToBuffer(this.bufs[n], 0, this.staging[n], 0, this.bufs[n].size);
    enc.clearBuffer(this.bufs.acc);
    enc.clearBuffer(this.bufs.sqAcc);
    dev.queue.submit([enc.finish()]);
    await Promise.all(READ_BACK.map((n) => this.staging[n].mapAsync(GPUMapMode.READ)));
    const get = (n: string) => new Float32Array(this.staging[n].getMappedRange());
    const h = get("h");
    for (let c = 0; c < N; c++) m.h[c] = h[c];
    const q = get("q");
    for (let c = 0; c < N; c++) {
      m.qx[c] = q[c * 2];
      m.qy[c] = q[c * 2 + 1];
    }
    const st = get("st");
    const soil = this.soilMask;
    let F = 0;
    for (let c = 0; c < N; c++) {
      const v = st[c * 2];
      if (soil[c]) {
        m.F[c] = v;
        F += v;
      } else if (m.infKind[c] === 2) m.S[c] = v;
      m.hPeak[c] = st[c * 2 + 1];
    }
    const acc = get("acc");
    let exf = 0,
      left = 0,
      dr = 0,
      fix = 0;
    for (let c = 0; c < N; c++) {
      exf += acc[c * 4];
      left += acc[c * 4 + 1];
      dr += acc[c * 4 + 2];
      fix += acc[c * 4 + 3];
    }
    // soil infiltration is the growth of the cumulative F; store exfiltration was accumulated
    m.vInfiltrated += (F - this.prevF + exf) * m.A;
    this.prevF = F;
    m.vLeft += left * m.A;
    m.vDrained += dr * m.A;
    m.vFixed += fix * m.A;
    const sq = get("sq");
    const sqAcc = get("sqAcc");
    m.squares.forEach((s, k) => {
      s.V = sq[k * 12];
      s.peakV = sq[k * 12 + 1];
      const e = sq[k * 12 + 9];
      s.emptyAt = e >= 0 ? e : null;
      s.everFilled = sq[k * 12 + 10] > 0.5;
      s.inflowAcc += sqAcc[k * 4];
      s.outflowAcc += sqAcc[k * 4 + 1];
      s.expectedAcc += sqAcc[k * 4 + 2];
      m.vDrained += sqAcc[k * 4 + 1];
    });
    const fc = get("featCap");
    m.cellFeatures.forEach((cf, k) => {
      if (cf.capPerCell > 0 && cf.target >= 0) cf.captured = fc[k];
      if (cf.f.kind === "garden" || cf.f.kind === "permeable") {
        let v = 0;
        for (const c of cf.cells) v += m.S[c] + (cf.f.kind === "garden" ? m.h[c] : 0);
        cf.peak = Math.max(cf.peak, v * m.A);
      }
    });
    for (const n of READ_BACK) this.staging[n].unmap();
  }

  destroy() {
    this.device.destroy();
  }
}
