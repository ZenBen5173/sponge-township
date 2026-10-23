/** Small, dependency-free geography helpers. Local frame: x metres east of the west edge, y metres south of the north edge. */

export interface Area {
  lat: number;
  lon: number;
  /** Side length of the square area, metres. */
  size: number;
  label?: string;
}

export interface BBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

export const CASIRA: Area = { lat: 3.0985, lon: 101.4135, size: 500, label: "Casira, Bandar Bukit Raja, Klang" };

const R = 6378137;

export function mPerDegLat(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
}

export function mPerDegLon(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
}

export function areaBBox(a: Area): BBox {
  const dLat = a.size / 2 / mPerDegLat(a.lat);
  const dLon = a.size / 2 / mPerDegLon(a.lat);
  return { s: a.lat - dLat, n: a.lat + dLat, w: a.lon - dLon, e: a.lon + dLon };
}

export class LocalFrame {
  readonly bbox: BBox;
  readonly mLat: number;
  readonly mLon: number;
  constructor(readonly area: Area) {
    this.bbox = areaBBox(area);
    this.mLat = mPerDegLat(area.lat);
    this.mLon = mPerDegLon(area.lat);
  }
  toXY(lat: number, lon: number): [number, number] {
    return [(lon - this.bbox.w) * this.mLon, (this.bbox.n - lat) * this.mLat];
  }
  toLatLon(x: number, y: number): [number, number] {
    return [this.bbox.n - y / this.mLat, this.bbox.w + x / this.mLon];
  }
}

/** Web-mercator global pixel coordinates at zoom z (256 px tiles). */
export function lonToPx(lon: number, z: number): number {
  return ((lon + 180) / 360) * 256 * 2 ** z;
}
export function latToPx(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
}

/** Metres per mercator pixel at a latitude. */
export function metresPerPx(lat: number, z: number): number {
  return (2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);
}

export function fmtLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
}

export function bboxContains(outer: BBox, inner: BBox): boolean {
  return inner.s >= outer.s && inner.n <= outer.n && inner.w >= outer.w && inner.e <= outer.e;
}
