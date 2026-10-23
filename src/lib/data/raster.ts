/** Scan-conversion onto a cell-centred grid (x east, y south, metres). */
export type XY = [number, number];

/** Calls cb(c) for every cell whose centre is inside the polygon (even-odd). */
export function fillPolygon(ring: XY[], nx: number, ny: number, dx: number, cb: (c: number) => void): number {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of ring) {
    if (p[1] < ymin) ymin = p[1];
    if (p[1] > ymax) ymax = p[1];
  }
  const j0 = Math.max(0, Math.ceil(ymin / dx - 0.5));
  const j1 = Math.min(ny - 1, Math.floor(ymax / dx - 0.5));
  let count = 0;
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * dx;
    xs.length = 0;
    for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
      const [xa, ya] = ring[m];
      const [xb, yb] = ring[k];
      if (ya > y !== yb > y) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / dx - 0.5));
      const i1 = Math.min(nx - 1, Math.floor(xs[k + 1] / dx - 0.5));
      for (let i = i0; i <= i1; i++) {
        cb(j * nx + i);
        count++;
      }
    }
  }
  return count;
}

/** Calls cb(c) for every cell whose centre lies within width/2 of the polyline (at least the cells it crosses). */
export function strokeLine(pts: XY[], width: number, nx: number, ny: number, dx: number, cb: (c: number) => void): void {
  const r = Math.max(width / 2, dx * 0.5);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / dx));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + r) / dx));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / dx));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + r) / dx));
    const vx = bx - ax;
    const vy = by - ay;
    const L2 = vx * vx + vy * vy || 1e-9;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * dx - ax;
        const py = (j + 0.5) * dx - ay;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / L2));
        const d = Math.hypot(px - t * vx, py - t * vy);
        if (d <= r) cb(j * nx + i);
      }
    }
  }
}

export function polygonArea(ring: XY[]): number {
  let a = 0;
  for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) a += ring[m][0] * ring[k][1] - ring[k][0] * ring[m][1];
  return Math.abs(a) / 2;
}

export function centroid(ring: XY[]): XY {
  let x = 0;
  let y = 0;
  const n = ring.length - (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
  for (let k = 0; k < n; k++) {
    x += ring[k][0];
    y += ring[k][1];
  }
  return [x / n, y / n];
}

/** Separable Gaussian blur of a grid in place. */
export function gaussianBlur(a: Float32Array, nx: number, ny: number, sigmaCells: number): void {
  if (sigmaCells < 0.3) return;
  const r = Math.ceil(sigmaCells * 3);
  const w = new Float32Array(2 * r + 1);
  let s = 0;
  for (let k = -r; k <= r; k++) s += w[k + r] = Math.exp((-k * k) / (2 * sigmaCells * sigmaCells));
  for (let k = 0; k < w.length; k++) w[k] /= s;
  const tmp = new Float32Array(a.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += w[k + r] * a[j * nx + Math.min(nx - 1, Math.max(0, i + k))];
      tmp[j * nx + i] = v;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += w[k + r] * tmp[Math.min(ny - 1, Math.max(0, j + k)) * nx + i];
      a[j * nx + i] = v;
    }
}

/** Deterministic smooth value noise in [-1, 1]. */
export function valueNoise(x: number, y: number, seed = 1): number {
  const hash = (i: number, j: number) => {
    let h = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  return 2 * ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) - 1;
}

/** Separable square minimum filter (morphological erosion) of radius r cells, in place. */
export function minFilter(a: Float32Array, nx: number, ny: number, r: number): void {
  if (r < 1) return;
  const tmp = new Float32Array(a.length);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let m = Infinity;
      for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) m = Math.min(m, a[j * nx + k]);
      tmp[j * nx + i] = m;
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let m = Infinity;
      for (let k = Math.max(0, j - r); k <= Math.min(ny - 1, j + r); k++) m = Math.min(m, tmp[k * nx + i]);
      a[j * nx + i] = m;
    }
}

/** Separable square maximum filter (dilation), in place. */
export function maxFilter(a: Float32Array, nx: number, ny: number, r: number): void {
  for (let c = 0; c < a.length; c++) a[c] = -a[c];
  minFilter(a, nx, ny, r);
  for (let c = 0; c < a.length; c++) a[c] = -a[c];
}

/**
 * Priority-flood depression filling (Barnes, Lehman & Mulla 2014) from the domain edges, then keep up
 * to `keep` metres of each depression: z' = max(z, filled − keep). Shallow sags stay; deep pits that
 * are artefacts of a coarse surface model are filled.
 */
export function fillDepressions(z: Float32Array, nx: number, ny: number, keep: number): void {
  const N = nx * ny;
  const filled = Float32Array.from(z);
  const done = new Uint8Array(N);
  // binary heap of cell indices keyed by filled elevation
  const heap: number[] = [];
  const less = (a: number, b: number) => filled[a] < filled[b];
  const push = (c: number) => {
    heap.push(c);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!less(heap[k], heap[p])) break;
      [heap[k], heap[p]] = [heap[p], heap[k]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === k) break;
        [heap[k], heap[m]] = [heap[m], heap[k]];
        k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < nx; i++) {
    for (const j of [0, ny - 1]) {
      const c = j * nx + i;
      if (!done[c]) {
        done[c] = 1;
        push(c);
      }
    }
  }
  for (let j = 1; j < ny - 1; j++)
    for (const i of [0, nx - 1]) {
      const c = j * nx + i;
      if (!done[c]) {
        done[c] = 1;
        push(c);
      }
    }
  while (heap.length) {
    const c = pop();
    const i = c % nx;
    const j = (c / nx) | 0;
    for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1]) {
      if (n < 0 || done[n]) continue;
      done[n] = 1;
      if (filled[n] < filled[c]) filled[n] = filled[c] + 1e-5;
      push(n);
    }
  }
  for (let c = 0; c < N; c++) z[c] = Math.max(z[c], filled[c] - keep);
}
