"use client";
import { type BBox, latToPx, lonToPx, metresPerPx } from "../geo";

/**
 * Tile sources. Both send `Access-Control-Allow-Origin: *`, so tiles can be drawn into a canvas and read back.
 * For the default Casira area a copy of every tile ships in /baked, used when the live server fails.
 */
export const TERRAIN_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const BAKED = (kind: string, z: number, x: number, y: number, ext: string) => `/baked/tiles/${kind}/${z}/${x}/${y}.${ext}`;

async function loadImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

async function loadTile(kind: "terrain" | "imagery", z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const ext = kind === "terrain" ? "png" : "jpg";
  const live = kind === "terrain" ? TERRAIN_URL(z, x, y) : IMAGERY_URL(z, x, y);
  try {
    return await loadImage(live);
  } catch {
    try {
      return await loadImage(BAKED(kind, z, x, y, ext));
    } catch {
      return null;
    }
  }
}

export interface Mosaic {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  /** Global pixel of the mosaic's top-left corner. */
  px0: number;
  py0: number;
  z: number;
  missing: number;
}

function makeCanvas(w: number, h: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    return { canvas: c, ctx: c.getContext("2d", { willReadFrequently: true })! };
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { canvas: c, ctx: c.getContext("2d", { willReadFrequently: true })! };
}

/** Fetch every tile covering bbox at zoom z and stitch them. */
export async function mosaic(kind: "terrain" | "imagery", bbox: BBox, z: number, onProgress?: (f: number) => void): Promise<Mosaic> {
  const x0 = Math.floor(lonToPx(bbox.w, z) / 256);
  const x1 = Math.floor(lonToPx(bbox.e, z) / 256);
  const y0 = Math.floor(latToPx(bbox.n, z) / 256);
  const y1 = Math.floor(latToPx(bbox.s, z) / 256);
  const w = (x1 - x0 + 1) * 256;
  const h = (y1 - y0 + 1) * 256;
  const { canvas, ctx } = makeCanvas(w, h);
  const jobs: Promise<void>[] = [];
  let done = 0;
  let missing = 0;
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(
        loadTile(kind, z, tx, ty).then((img) => {
          if (img) ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
          else missing++;
          done++;
          onProgress?.(done / total);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return { canvas, ctx, px0: x0 * 256, py0: y0 * 256, z, missing };
}

/** Terrarium elevation (m) at the cell centres of an nx × ny grid over bbox, bilinear. */
export async function loadElevation(bbox: BBox, nx: number, ny: number, onProgress?: (f: number) => void): Promise<{ z: Float32Array; missing: number; z15: number }> {
  const zoom = 15; // ~4.6 m pixels; the underlying data is ~30 m (SRTM), resampled by the tile service
  const m = await mosaic("terrain", bbox, zoom, onProgress);
  const data = m.ctx.getImageData(0, 0, m.canvas.width, m.canvas.height).data;
  const W = m.canvas.width;
  const H = m.canvas.height;
  const elev = (px: number, py: number) => {
    const x = Math.min(W - 1, Math.max(0, px));
    const y = Math.min(H - 1, Math.max(0, py));
    const k = (y * W + x) * 4;
    return data[k] * 256 + data[k + 1] + data[k + 2] / 256 - 32768;
  };
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = bbox.n - ((j + 0.5) / ny) * (bbox.n - bbox.s);
    const py = latToPx(lat, zoom) - m.py0 - 0.5;
    for (let i = 0; i < nx; i++) {
      const lon = bbox.w + ((i + 0.5) / nx) * (bbox.e - bbox.w);
      const px = lonToPx(lon, zoom) - m.px0 - 0.5;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const fx = px - ix;
      const fy = py - iy;
      const a = elev(ix, iy);
      const b = elev(ix + 1, iy);
      const c = elev(ix, iy + 1);
      const d = elev(ix + 1, iy + 1);
      out[j * nx + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return { z: out, missing: m.missing, z15: zoom };
}

/** Satellite image cropped exactly to bbox, at most `maxPx` wide. */
export async function loadImagery(
  bbox: BBox,
  size: number,
  maxPx = 2048,
  onProgress?: (f: number) => void,
): Promise<{ canvas: HTMLCanvasElement; missing: number; zoom: number }> {
  const lat = (bbox.n + bbox.s) / 2;
  let zoom = 19;
  while (zoom > 12 && size / metresPerPx(lat, zoom) > maxPx) zoom--;
  zoom = Math.min(zoom, 18);
  const m = await mosaic("imagery", bbox, zoom, onProgress);
  const sx = lonToPx(bbox.w, zoom) - m.px0;
  const sy = latToPx(bbox.n, zoom) - m.py0;
  const sw = lonToPx(bbox.e, zoom) - m.px0 - sx;
  const sh = latToPx(bbox.s, zoom) - m.py0 - sy;
  const out = document.createElement("canvas");
  const px = Math.min(maxPx, Math.round(Math.max(sw, sh)));
  out.width = px;
  out.height = px;
  const octx = out.getContext("2d", { willReadFrequently: true })!;
  octx.fillStyle = "#3a4a3a";
  octx.fillRect(0, 0, px, px);
  octx.drawImage(m.canvas as CanvasImageSource, sx, sy, sw, sh, 0, 0, px, px);
  return { canvas: out, missing: m.missing, zoom };
}
