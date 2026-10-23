"use client";
import { type Area, LocalFrame } from "../geo";
import { Land, type GridData } from "../sim/types";
import { loadOsm, type OsmData } from "./osm";
import { detectRoofs } from "./roofs";
import { centroid, fillDepressions, fillPolygon, gaussianBlur, maxFilter, minFilter, polygonArea, strokeLine, valueNoise, type XY } from "./raster";
import { loadElevation, loadImagery } from "./tiles";

export interface SceneBuilding {
  id: number;
  ring: XY[];
  height: number;
  /** Ground under the building (m, grid datum). */
  base: number;
  kind: string;
  /** Roof colour sampled from the imagery, 0xRRGGBB. */
  roof: number;
  cells: number;
  /** true = read from the satellite image (not in OpenStreetMap) */
  detected?: boolean;
  /** ring edge (0 or 1) whose direction the roof ridge follows */
  ridgeEdge?: number;
}

export interface Candidate {
  id: string;
  label: string;
  kind: string;
  area: number;
  cx: number;
  cy: number;
  /** Most open spot (deepest inside the site), metres. */
  bx: number;
  by: number;
  /** Radius of the biggest circle that fits, m. */
  fit: number;
  rot: number;
  relElev: number;
  /** ground area (m²) whose runoff flows into the site, from D8 flow accumulation */
  inflowArea: number;
  housesNear: number;
  /** after a run of the town as it is: homes with water at the door, and the deepest street, within 150 m */
  floodedNear?: number;
  deepestNear?: number;
  /** court that fits: size (m) at (bx, by) */
  courtW: number;
  courtL: number;
  score: number;
  fits: boolean;
  cells: Int32Array;
  name?: string;
}

export interface SceneData {
  area: Area;
  frame: LocalFrame;
  size: number;
  grid: GridData;
  imagery: HTMLCanvasElement;
  osm: OsmData;
  buildings: SceneBuilding[];
  roads: { pts: XY[]; width: number; kind: string; name?: string }[];
  waterways: { pts: XY[]; width: number; kind: string }[];
  candidates: Candidate[];
  /** Candidate index + 1 per cell (0 = none). */
  candidateMask: Uint8Array;
  warnings: string[];
  demRange: [number, number];
  imageryZoom: number;
}

export type Progress = (label: string, f: number) => void;

/** Grid spacing for an area: ~145 cells a side, never finer than 2.5 m or coarser than 14 m. */
export function gridFor(size: number) {
  const dx0 = Math.min(14, Math.max(2.5, size / 145));
  const nx = Math.round(size / dx0);
  return { nx, ny: nx, dx: size / nx };
}

export async function buildScene(area: Area, onProgress: Progress = () => {}): Promise<SceneData> {
  const frame = new LocalFrame(area);
  const bbox = frame.bbox;
  const size = area.size;
  const { nx, ny, dx } = gridFor(size);
  const N = nx * ny;
  const warnings: string[] = [];

  let pT = 0;
  let pI = 0;
  let pO = 0;
  const report = (label: string) => onProgress(label, (pT + pI + pO) / 3);
  const [elev, img, osmRes] = await Promise.all([
    loadElevation(bbox, nx, ny, (f) => {
      pT = f;
      report("Elevation tiles");
    }),
    loadImagery(bbox, size, size > 1200 ? 2048 : 1536, (f) => {
      pI = f;
      report("Satellite imagery");
    }),
    loadOsm(bbox).then((r) => {
      pO = 1;
      report("Buildings & roads");
      return r;
    }),
  ]);
  if (elev.missing) warnings.push(`${elev.missing} elevation tile(s) missing; ground there is flat.`);
  if (img.missing) warnings.push(`${img.missing} imagery tile(s) missing.`);
  if (osmRes.warning) warnings.push(osmRes.warning);
  const osm = osmRes.data;
  onProgress("Building the ground", 0.92);

  // ── Elevation: the free DEM (~30 m, SRTM-based) is a surface model — it sees roofs and trees, so
  // open fields between houses look like pits. Make a bare-earth proxy: a morphological opening
  // (erode then dilate over ~40 m) drops the roof/canopy bumps, a Gaussian smooths the 30 m steps,
  // and priority-flood filling removes the pits that remain, keeping sags of up to 25 cm. ──
  const zRaw = elev.z;
  const rOpen = Math.max(1, Math.round(20 / dx));
  minFilter(zRaw, nx, ny, rOpen);
  maxFilter(zRaw, nx, ny, rOpen);
  gaussianBlur(zRaw, nx, ny, 18 / dx);
  fillDepressions(zRaw, nx, ny, 0.25);
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let c = 0; c < N; c++) {
    if (zRaw[c] < zmin) zmin = zRaw[c];
    if (zRaw[c] > zmax) zmax = zRaw[c];
  }

  // ── Land classes ─────────────────────────────────────────────────────────────────────────
  const land = new Uint8Array(N).fill(Land.Open);
  const construction = new Uint8Array(N);
  const areaName = new Int32Array(N).fill(-1);
  const toXY = (ll: [number, number]): XY => frame.toXY(ll[0], ll[1]);
  osm.areas.forEach((a, k) => {
    const ring = a.ring.map(toXY);
    fillPolygon(ring, nx, ny, dx, (c) => {
      if (a.cls === "green") land[c] = Land.Green;
      else if (a.cls === "water") land[c] = Land.Water;
      else if (a.cls === "paved") land[c] = Land.Paved;
      else if (a.cls === "construction") construction[c] = 1;
      if (a.name && a.cls !== "other") areaName[c] = k;
    });
  });
  const roads = osm.roads.map((r) => ({ pts: r.pts.map(toXY), width: r.width, kind: r.kind, name: r.name }));
  for (const r of roads) {
    const cls = r.kind === "footway" || r.kind === "path" || r.kind === "cycleway" || r.kind === "pedestrian" ? Land.Paved : Land.Road;
    strokeLine(r.pts, r.width, nx, ny, dx, (c) => {
      if (land[c] !== Land.Water) land[c] = cls === Land.Road || land[c] !== Land.Road ? cls : land[c];
    });
  }
  const waterways = osm.waterways.map((w) => ({ pts: w.pts.map(toXY), width: w.width, kind: w.kind }));
  for (const w of waterways) strokeLine(w.pts, w.width, nx, ny, dx, (c) => (land[c] = Land.Channel));

  const buildingId = new Int32Array(N).fill(-1);
  const buildings: SceneBuilding[] = [];
  for (const b of osm.buildings) {
    const ring = b.ring.map(toXY);
    const id = buildings.length;
    let cells = 0;
    let zs = 0;
    fillPolygon(ring, nx, ny, dx, (c) => {
      buildingId[c] = id;
      land[c] = Land.Building;
      cells++;
      zs += zRaw[c];
    });
    const [cx, cy] = centroid(ring);
    if (cells === 0) {
      const i = Math.floor(cx / dx);
      const j = Math.floor(cy / dx);
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      if (polygonArea(ring) > 0.3 * dx * dx) {
        const c = j * nx + i;
        buildingId[c] = id;
        land[c] = Land.Building;
        cells = 1;
        zs = zRaw[c];
      } else continue;
    }
    buildings.push({ id, ring, height: b.height, base: 0, kind: b.kind, roof: 0x9a6b55, cells });
    buildings[id].base = zs / cells;
  }

  // ── Imagery: unmapped grass shows up green ──────────────────────────────────────────────
  const W = img.canvas.width;
  const pix = img.canvas.getContext("2d")!.getImageData(0, 0, W, W).data;
  const sample = (x: number, y: number) => {
    const px = Math.min(W - 1, Math.max(0, Math.floor((x / size) * W)));
    const py = Math.min(W - 1, Math.max(0, Math.floor((y / size) * W)));
    const k = (py * W + px) * 4;
    return [pix[k], pix[k + 1], pix[k + 2]];
  };
  const imgGreen = new Uint8Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      // average a 3×3 patch of pixels in the cell
      let r = 0,
        g = 0,
        b = 0;
      for (let a = 0; a < 3; a++)
        for (let d = 0; d < 3; d++) {
          const s = sample((i + 0.2 + a * 0.3) * dx, (j + 0.2 + d * 0.3) * dx);
          r += s[0];
          g += s[1];
          b += s[2];
        }
      const sum = r + g + b + 1;
      const exg = (2 * g - r - b) / sum;
      if (exg > 0.045 && g / 9 > 45) imgGreen[c] = 1;
    }
  for (let c = 0; c < N; c++) if (land[c] === Land.Open && imgGreen[c]) land[c] = Land.Green;
  for (const b of buildings) {
    const [cx, cy] = centroid(b.ring);
    const s = sample(cx, cy);
    b.roof = (s[0] << 16) | (s[1] << 8) | s[2];
  }

  // Houses missing from OpenStreetMap, read from the satellite image
  // dominant street direction (circular mean of 4θ, so 0°/90° agree)
  let c4 = 0;
  let s4 = 0;
  for (const r of roads)
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const [ax, ay] = r.pts[k];
      const [bx, by] = r.pts[k + 1];
      const L = Math.hypot(bx - ax, by - ay);
      const a = Math.atan2(by - ay, bx - ax);
      c4 += L * Math.cos(4 * a);
      s4 += L * Math.sin(4 * a);
    }
  const streetAngle = Math.hypot(c4, s4) > 50 ? Math.atan2(s4, c4) / 4 : null;
  const houses = detectRoofs(land, nx, ny, dx, pix, W, size, new Uint8Array(N), streetAngle);
  for (const h of houses) {
    const id = buildings.length;
    let zs = 0;
    for (const c of h.cells) {
      land[c] = Land.Building;
      buildingId[c] = id;
      zs += zRaw[c];
    }
    buildings.push({ id, ring: h.ring, height: h.height, base: zs / h.cells.length, kind: "house", roof: h.roof, cells: h.cells.length, detected: true, ridgeEdge: 0 });
  }

  // ── Street-level detail the 30 m DEM cannot see ──────────────────────────────────────────
  // House platforms sit above the road crown; roads carry the water; drains are sunk channels;
  // ponds have a bed. A 3 cm micro-relief stands in for kerbs, potholes and driveways.
  const z = new Float32Array(N);
  const zFlow = new Float32Array(N); // same ground without the micro-relief, for flow routing
  const h0 = new Float32Array(N);
  // distance to the nearest building: yards next to houses sit on raised platforms, vacant land does not
  const bDist = new Float64Array(N).fill(1e9);
  {
    const q: number[] = [];
    for (let c = 0; c < N; c++)
      if (land[c] === Land.Building) {
        bDist[c] = 0;
        q.push(c);
      }
    for (let k = 0; k < q.length; k++) {
      const c = q[k];
      const i = c % nx;
      const j = (c / nx) | 0;
      for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1])
        if (n >= 0 && bDist[n] > bDist[c] + dx) {
          bDist[n] = bDist[c] + dx;
          q.push(n);
        }
    }
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      let v = zRaw[c] - zmin;
      const L = land[c];
      if (L === Land.Open) v += construction[c] ? 0 : bDist[c] <= 9 ? 0.25 : 0.08;
      else if (L === Land.Green) v += 0.05;
      else if (L === Land.Paved) v += 0.1;
      else if (L === Land.Building) v += 0.3;
      else if (L === Land.Channel) v -= 1.2;
      else if (L === Land.Water) {
        v -= 2.0;
        h0[c] = 1.2;
      }
      zFlow[c] = v;
      if (L !== Land.Water && L !== Land.Channel) v += 0.03 * valueNoise((i * dx) / 11, (j * dx) / 11, 7) + 0.012 * valueNoise((i * dx) / 4, (j * dx) / 4, 3);
      z[c] = v;
    }
  for (const b of buildings) b.base = b.base - zmin + 0.3;

  // ── Open space: candidate sites for a water square ──────────────────────────────────────
  onProgress("Finding open space", 0.97);
  const open = new Uint8Array(N);
  for (let c = 0; c < N; c++) open[c] = land[c] === Land.Green || (construction[c] && land[c] === Land.Open) ? 1 : 0;
  // opening (erode then dilate one cell) removes verges and thin strips
  const er = new Uint8Array(N);
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const c = j * nx + i;
      er[c] = open[c] & open[c - 1] & open[c + 1] & open[c - nx] & open[c + nx];
    }
  const op = new Uint8Array(N);
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const c = j * nx + i;
      op[c] = open[c] & (er[c] | er[c - 1] | er[c + 1] | er[c - nx] | er[c + nx]);
    }
  // distance to the nearest non-open cell (two-pass chamfer), metres
  const dist = new Float32Array(N);
  for (let c = 0; c < N; c++) dist[c] = op[c] ? 1e9 : 0;
  const D1 = dx;
  const D2 = dx * Math.SQRT2;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!dist[c]) continue;
      let d = dist[c];
      if (i > 0) d = Math.min(d, dist[c - 1] + D1);
      if (j > 0) d = Math.min(d, dist[c - nx] + D1);
      if (i > 0 && j > 0) d = Math.min(d, dist[c - nx - 1] + D2);
      if (i < nx - 1 && j > 0) d = Math.min(d, dist[c - nx + 1] + D2);
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) d = Math.min(d, D1);
      dist[c] = d;
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const c = j * nx + i;
      if (!dist[c]) continue;
      let d = dist[c];
      if (i < nx - 1) d = Math.min(d, dist[c + 1] + D1);
      if (j < ny - 1) d = Math.min(d, dist[c + nx] + D1);
      if (i < nx - 1 && j < ny - 1) d = Math.min(d, dist[c + nx + 1] + D2);
      if (i > 0 && j < ny - 1) d = Math.min(d, dist[c + nx - 1] + D2);
      dist[c] = d;
    }
  // Flow accumulation (D8 on the ground, buildings excluded): how much area drains through each cell.
  const accum = new Float32Array(N);
  {
    fillDepressions(zFlow, nx, ny, 0); // route across flats and through sags
    const order = Array.from({ length: N }, (_, c) => c).filter((c) => land[c] !== Land.Building);
    order.sort((a, b) => zFlow[b] - zFlow[a]);
    for (const c of order) accum[c] += dx * dx;
    for (const c of order) {
      const i = c % nx;
      const j = (c / nx) | 0;
      let best = -1;
      let drop = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const n = jj * nx + ii;
          if (land[n] === Land.Building) continue;
          const s = (zFlow[c] - zFlow[n]) / (di && dj ? Math.SQRT2 : 1);
          if (s > drop) {
            drop = s;
            best = n;
          }
        }
      if (best >= 0) accum[best] += accum[c];
    }
  }
  const sorted = Float32Array.from(z).sort();
  const zMed = sorted[N >> 1];
  const comp = new Int32Array(N).fill(-1);
  const cands: Candidate[] = [];
  const bcent = buildings.map((b) => centroid(b.ring));
  for (let c0 = 0; c0 < N; c0++) {
    if (!op[c0] || comp[c0] >= 0) continue;
    const stack = [c0];
    const cells: number[] = [];
    comp[c0] = -2;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const i = c % nx;
      const j = (c / nx) | 0;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
      for (const d of nb)
        if (d >= 0 && op[d] && comp[d] === -1) {
          comp[d] = -2;
          stack.push(d);
        }
    }
    const a = cells.length * dx * dx;
    if (a < 900) continue;
    let sx = 0,
      sy = 0,
      sz = 0,
      best = 0,
      bc = cells[0],
      nGreen = 0,
      nCons = 0,
      nameK = -1;
    for (const c of cells) {
      const x = ((c % nx) + 0.5) * dx;
      const y = (((c / nx) | 0) + 0.5) * dx;
      sx += x;
      sy += y;
      sz += z[c];
      if (dist[c] > best) {
        best = dist[c];
        bc = c;
      }
      if (construction[c]) nCons++;
      else nGreen++;
      if (areaName[c] >= 0) nameK = areaName[c];
    }
    const cx = sx / cells.length;
    const cy = sy / cells.length;
    // principal axis for the square's orientation
    let sxx = 0,
      syy = 0,
      sxy = 0;
    for (const c of cells) {
      const x = ((c % nx) + 0.5) * dx - cx;
      const y = (((c / nx) | 0) + 0.5) * dx - cy;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    let rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // line the court up with the streets (it reads as planned, and drains run straight)
    if (streetAngle !== null) {
      let bestA = rot;
      let bd = Infinity;
      for (let k = -2; k <= 2; k++) {
        const a2 = streetAngle + (k * Math.PI) / 2;
        const d = Math.abs(Math.atan2(Math.sin(2 * (rot - a2)), Math.cos(2 * (rot - a2))));
        if (d < bd) {
          bd = d;
          bestA = a2;
        }
      }
      rot = bestA;
    }
    // put the square at the lowest spot where it fits (water comes to it), else the most open spot
    const need = Math.min(15, best * 0.9);
    let low = Infinity;
    for (const c of cells)
      if (dist[c] >= need && z[c] < low) {
        low = z[c];
        bc = c;
      }
    const bx = ((bc % nx) + 0.5) * dx;
    const by = (((bc / nx) | 0) + 0.5) * dx;
    // area that drains into the site: the largest accumulation on its cells or a cell beside them
    let inflowArea = 0;
    for (const c of cells) {
      const i = c % nx;
      const j = (c / nx) | 0;
      for (const n of [c, i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1])
        if (n >= 0 && accum[n] > inflowArea) inflowArea = accum[n];
    }
    let houses = 0;
    for (const [x, y] of bcent) if (Math.hypot(x - bx, y - by) < 150) houses++;
    const relElev = sz / cells.length - zMed;
    const fits = best >= 15;
    const score =
      35 * (fits ? 1 : best / 15) +
      25 * Math.min(1, Math.log10(1 + inflowArea / 500) / Math.log10(1 + 40000 / 500)) +
      15 * Math.max(0, Math.min(1, -relElev / 0.6 + 0.5)) +
      15 * Math.min(1, houses / 120) +
      10 * Math.min(1, a / 6000);
    const name = nameK >= 0 ? osm.areas[nameK].name : undefined;
    cands.push({
      id: `site-${cands.length}`,
      label: "",
      kind: nCons > nGreen ? "Construction / vacant land" : a > 8000 ? "Open field" : "Open grass",
      area: a,
      cx,
      cy,
      bx,
      by,
      fit: best,
      courtW: 0,
      courtL: 0,
      rot,
      relElev,
      inflowArea,
      housesNear: houses,
      score: Math.round(score),
      fits,
      cells: Int32Array.from(cells),
      name,
    });
  }
  cands.sort((p, q) => q.score - p.score);
  const top = cands.slice(0, 8);
  const candidateMask = new Uint8Array(N);
  top.forEach((cd, k) => {
    cd.label = `Site ${String.fromCharCode(65 + k)}`;
    cd.id = `site-${String.fromCharCode(97 + k)}`;
    for (const c of cd.cells) candidateMask[c] = k + 1;
  });
  top.forEach((cd, k) => {
    // before any run: the court goes on the lowest ground where it fits
    const p = placeCourt(cd, k, { nx, ny, dx }, candidateMask, (c) => -z[c]);
    if (p) {
      cd.bx = p.x;
      cd.by = p.y;
      cd.courtW = p.w;
      cd.courtL = p.l;
    }
    cd.fits = !!p && p.w >= 40;
  });

  const grid: GridData = { nx, ny, dx, z, z0: zmin, land, buildingId, nBuildings: buildings.length, h0 };
  onProgress("Ready", 1);
  return {
    area,
    frame,
    size,
    grid,
    imagery: img.canvas,
    osm,
    buildings,
    roads,
    waterways,
    candidates: top,
    candidateMask,
    warnings,
    demRange: [zmin, zmax],
    imageryZoom: img.zoom,
  };
}

/**
 * Where a court of the largest size in `sizes` fits inside a candidate site (≥ 97 % of its cells on
 * the site, at the site's street-aligned angle), choosing the spot with the highest `value` summed
 * over the footprint plus a 10 m margin (e.g. low ground, or water pooled in a previous run).
 */
export function placeCourt(
  cd: Candidate,
  index: number,
  grid: { nx: number; ny: number; dx: number },
  mask: Uint8Array,
  value: (c: number) => number,
  sizes: [number, number][] = [
    [40, 30],
    [34, 26],
    [28, 21],
    [22, 16],
  ],
): { x: number; y: number; w: number; l: number } | null {
  const { nx, ny, dx } = grid;
  const cs = Math.cos(cd.rot);
  const sn = Math.sin(cd.rot);
  for (const [w, l] of sizes) {
    let best: { x: number; y: number; v: number } | null = null;
    const stepC = Math.max(1, Math.round(2 / dx));
    for (let k = 0; k < cd.cells.length; k += stepC) {
      const c0 = cd.cells[k];
      const x = ((c0 % nx) + 0.5) * dx;
      const y = (((c0 / nx) | 0) + 0.5) * dx;
      const r = Math.hypot(w, l) / 2 + 10;
      let inside = 0;
      let total = 0;
      let v = 0;
      const i0 = Math.max(0, Math.floor((x - r) / dx));
      const i1 = Math.min(nx - 1, Math.ceil((x + r) / dx));
      const j0 = Math.max(0, Math.floor((y - r) / dx));
      const j1 = Math.min(ny - 1, Math.ceil((y + r) / dx));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const px = (i + 0.5) * dx - x;
          const py = (j + 0.5) * dx - y;
          const u = Math.abs(px * cs + py * sn);
          const q = Math.abs(-px * sn + py * cs);
          const c = j * nx + i;
          if (u <= w / 2 && q <= l / 2) {
            total++;
            if (mask[c] === index + 1) inside++;
          }
          if (u <= w / 2 + 10 && q <= l / 2 + 10) v += value(c);
        }
      if (total === 0 || inside < total * 0.97) continue;
      if (!best || v > best.v) best = { x, y, v };
    }
    if (best) return { x: best.x, y: best.y, w, l };
  }
  return null;
}
