import { Land } from "../sim/types";
import type { XY } from "./raster";

/**
 * Houses OpenStreetMap does not have. In many Malaysian townships most terrace houses are unmapped,
 * so we read roofs from the satellite image: inside street blocks, set back from the road, cells that
 * look like roof (terracotta or dark grey, or busy with ridges and shadows) and not like grass, bare
 * soil or smooth asphalt. Each connected patch is cut into ~7 m wide units along its long side, the
 * frontage of a typical terrace house, and each unit becomes a building.
 */

export interface DetectedHouse {
  ring: XY[];
  cells: number[];
  roof: number;
  height: number;
}

export function detectRoofs(
  land: Uint8Array,
  nx: number,
  ny: number,
  dx: number,
  pix: Uint8ClampedArray,
  W: number,
  size: number,
  protectedCells: Uint8Array,
  /** dominant street direction (radians, mod π/2); house rows are snapped to it */
  streetAngle: number | null = null,
): DetectedHouse[] {
  const N = nx * ny;
  // distance to the nearest road cell (BFS, metres)
  const dist = new Float64Array(N).fill(1e9);
  const q = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  for (let c = 0; c < N; c++)
    if (land[c] === Land.Road) {
      dist[c] = 0;
      q[qt++] = c;
    }
  while (qh < qt) {
    const c = q[qh++];
    const i = c % nx;
    const j = (c / nx) | 0;
    const d = dist[c] + dx;
    for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1]) {
      if (n >= 0 && dist[n] > d) {
        dist[n] = d;
        q[qt++] = n;
      }
    }
  }

  const px = (W / size) * dx; // pixels per cell
  const roof = new Uint8Array(N);
  const col = new Uint32Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (land[c] !== Land.Open || protectedCells[c]) continue;
      if (dist[c] < 3 || dist[c] > 32) continue;
      let r = 0,
        g = 0,
        b = 0,
        l2 = 0,
        n = 0;
      const x0 = Math.floor(i * px);
      const y0 = Math.floor(j * px);
      const x1 = Math.max(x0 + 1, Math.floor((i + 1) * px));
      const y1 = Math.max(y0 + 1, Math.floor((j + 1) * px));
      for (let y = y0; y < y1 && y < W; y++)
        for (let x = x0; x < x1 && x < W; x++) {
          const k = (y * W + x) * 4;
          r += pix[k];
          g += pix[k + 1];
          b += pix[k + 2];
          const lum = 0.3 * pix[k] + 0.59 * pix[k + 1] + 0.11 * pix[k + 2];
          l2 += lum * lum;
          n++;
        }
      if (!n) continue;
      r /= n;
      g /= n;
      b /= n;
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      const std = Math.sqrt(Math.max(0, l2 / n - lum * lum));
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      const green = (2 * g - r - b) / (r + g + b + 1) > 0.04;
      const terracotta = r > g + 16 && r > b + 30 && lum < 190 && sat > 0.22;
      const darkRoof = lum < 92 && sat < 0.35;
      const greyRoof = lum < 165 && sat < 0.2 && std > 14;
      const busy = std > 26;
      const bare = lum > 120 && r > b + 22 && std < 18 && !terracotta;
      const asphalt = lum >= 92 && lum < 150 && sat < 0.16 && std < 14;
      if (!green && !bare && !asphalt && (terracotta || darkRoof || greyRoof || busy)) {
        roof[c] = 1;
        col[c] = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
      }
    }
  // closing then opening (3×3) to make solid roofs and drop specks
  const morph = (src: Uint8Array, dilate: boolean) => {
    const out = new Uint8Array(N);
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = j * nx + i;
        let v = dilate ? 0 : 1;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const s = src[c + dj * nx + di];
            if (dilate) v |= s;
            else v &= s;
          }
        out[c] = v;
      }
    return out;
  };
  const allowed = (c: number) => land[c] === Land.Open && !protectedCells[c] && dist[c] >= 3;
  let m = morph(roof, true);
  m = morph(m, false);
  for (let c = 0; c < N; c++) if (!allowed(c)) m[c] = 0;
  const er = morph(m, false);
  m = morph(er, true);
  for (let c = 0; c < N; c++) if (!allowed(c)) m[c] = 0;

  // components → oriented strips → ~7 m units
  const seen = new Uint8Array(N);
  const houses: DetectedHouse[] = [];
  for (let c0 = 0; c0 < N; c0++) {
    if (!m[c0] || seen[c0]) continue;
    const comp: number[] = [];
    const st = [c0];
    seen[c0] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const i = c % nx;
      const j = (c / nx) | 0;
      for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1])
        if (n >= 0 && m[n] && !seen[n]) {
          seen[n] = 1;
          st.push(n);
        }
    }
    const area = comp.length * dx * dx;
    if (area < 60 || area > 12000) continue;
    let sx = 0,
      sy = 0;
    for (const c of comp) {
      sx += ((c % nx) + 0.5) * dx;
      sy += (((c / nx) | 0) + 0.5) * dx;
    }
    const cx = sx / comp.length;
    const cy = sy / comp.length;
    let sxx = 0,
      syy = 0,
      sxy = 0;
    for (const c of comp) {
      const x = ((c % nx) + 0.5) * dx - cx;
      const y = (((c / nx) | 0) + 0.5) * dx - cy;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    if (streetAngle !== null) {
      // terraces run along streets: snap to the street grid when within 30°
      let best = ang;
      let bd = Math.PI / 6;
      for (let k = -2; k <= 2; k++) {
        const a = streetAngle + (k * Math.PI) / 2;
        const d = Math.abs(Math.atan2(Math.sin(2 * (ang - a)), Math.cos(2 * (ang - a)))) / 2;
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
      ang = best;
    }
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    let umin = Infinity,
      umax = -Infinity,
      vmin = Infinity,
      vmax = -Infinity;
    for (const c of comp) {
      const x = ((c % nx) + 0.5) * dx - cx;
      const y = (((c / nx) | 0) + 0.5) * dx - cy;
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      umin = Math.min(umin, u);
      umax = Math.max(umax, u);
      vmin = Math.min(vmin, v);
      vmax = Math.max(vmax, v);
    }
    umin -= dx / 2;
    umax += dx / 2;
    vmin -= dx / 2;
    vmax += dx / 2;
    const len = umax - umin;
    const wid = vmax - vmin;
    if (wid < 4.5) continue;
    const units = Math.max(1, Math.round(len / 7));
    const uw = len / units;
    // back-to-back terraces: split deep patches into rows ~17 m deep
    const rows = wid > 26 ? Math.max(1, Math.round(wid / 17)) : 1;
    const vw = wid / rows;
    const nb = units * rows;
    const buckets: number[][] = Array.from({ length: nb }, () => []);
    const colors: number[][] = Array.from({ length: nb }, () => [0, 0, 0, 0]);
    for (const c of comp) {
      const x = ((c % nx) + 0.5) * dx - cx;
      const y = (((c / nx) | 0) + 0.5) * dx - cy;
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      const ku = Math.min(units - 1, Math.max(0, Math.floor((u - umin) / uw)));
      const kv = Math.min(rows - 1, Math.max(0, Math.floor((v - vmin) / vw)));
      const k = ku * rows + kv;
      buckets[k].push(c);
      const cc = col[c];
      if (cc) {
        colors[k][0] += (cc >> 16) & 255;
        colors[k][1] += (cc >> 8) & 255;
        colors[k][2] += cc & 255;
        colors[k][3]++;
      }
    }
    const P = (u: number, v: number): XY => [cx + u * ux - v * uy, cy + u * uy + v * ux];
    for (let k = 0; k < nb; k++) {
      if (buckets[k].length * dx * dx < 0.35 * uw * vw) continue;
      const ku = Math.floor(k / rows);
      const kv = k % rows;
      // the unit's own depth (rows' back walls meet in the middle)
      let a = Infinity,
        b = -Infinity;
      for (const c of buckets[k]) {
        const x = ((c % nx) + 0.5) * dx - cx;
        const y = (((c / nx) | 0) + 0.5) * dx - cy;
        const v = -x * uy + y * ux;
        a = Math.min(a, v);
        b = Math.max(b, v);
      }
      a = Math.max(a - dx / 2, vmin + kv * vw);
      b = Math.min(b + dx / 2, vmin + (kv + 1) * vw);
      const u0 = umin + ku * uw + 0.25;
      const u1 = umin + (ku + 1) * uw - 0.25;
      const n = colors[k][3] || 1;
      const roofCol = colors[k][3] ? (Math.round(colors[k][0] / n) << 16) | (Math.round(colors[k][1] / n) << 8) | Math.round(colors[k][2] / n) : 0x7a6a60;
      houses.push({ ring: [P(u0, a), P(u1, a), P(u1, b), P(u0, b), P(u0, a)], cells: buckets[k], roof: roofCol, height: 7 + ((ku * 13) % 3) * 0.3 });
    }
  }
  return houses;
}
