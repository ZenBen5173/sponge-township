"use client";
/**
 * Fallback source for buildings, roads and land use: OpenStreetMap as vector tiles from OpenFreeMap
 * (CDN-served, open CORS, OpenMapTiles schema). Used when the Overpass servers are busy.
 */
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { BBox } from "../geo";
import type { AreaClass, LL, OsmData } from "./osm";

const TILEJSON = "https://tiles.openfreemap.org/planet";
const Z = 14;

const ROAD_WIDTH: Record<string, number> = {
  motorway: 24,
  trunk: 20,
  primary: 16,
  secondary: 14,
  tertiary: 12,
  minor: 7,
  service: 5,
  track: 3,
  path: 2,
  raceway: 8,
  busway: 8,
};

const lon2tile = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const lat2tile = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** Z);
};

let template: string | null = null;

export async function loadOsmFromTiles(bbox: BBox, signal?: AbortSignal): Promise<OsmData> {
  if (!template) {
    const tj = await (await fetch(TILEJSON, { signal })).json();
    template = tj.tiles[0] as string;
  }
  const out: OsmData = { buildings: [], roads: [], areas: [], waterways: [], source: "live" };
  const x0 = lon2tile(bbox.w);
  const x1 = lon2tile(bbox.e);
  const y0 = lat2tile(bbox.n);
  const y1 = lat2tile(bbox.s);
  let id = 1;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      jobs.push(
        (async () => {
          const url = template!.replace("{z}", String(Z)).replace("{x}", String(x)).replace("{y}", String(y));
          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(`tiles ${res.status}`);
          const tile = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
          const each = (name: string, cb: (g: GeoJSON.Geometry, p: Record<string, unknown>) => void) => {
            const layer = tile.layers[name];
            if (!layer) return;
            for (let k = 0; k < layer.length; k++) {
              const f = layer.feature(k).toGeoJSON(x, y, Z);
              cb(f.geometry, f.properties ?? {});
            }
          };
          const rings = (g: GeoJSON.Geometry): LL[][] => {
            const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
            return polys.map((p) => p[0].map(([lo, la]) => [la, lo] as LL)).filter((r) => r.length >= 4);
          };
          const lines = (g: GeoJSON.Geometry): LL[][] => {
            const ls = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
            return ls.map((l) => l.map(([lo, la]) => [la, lo] as LL)).filter((l) => l.length >= 2);
          };
          each("building", (g, p) => {
            const hgt = Number(p.render_height ?? p.height ?? 0);
            for (const ring of rings(g)) out.buildings.push({ id: id++, ring, height: hgt > 0 ? hgt : 7.5, kind: "yes" });
          });
          each("transportation", (g, p) => {
            const cls = String(p.class ?? "minor");
            if (p.brunnel === "tunnel") return;
            const width = ROAD_WIDTH[cls] ?? 6;
            const kind = cls === "path" ? "footway" : cls === "minor" ? "residential" : cls;
            for (const pts of lines(g)) out.roads.push({ id: id++, pts, kind, width });
          });
          const area = (layer: string, map: (p: Record<string, unknown>) => AreaClass | null) =>
            each(layer, (g, p) => {
              const cls = map(p);
              if (!cls) return;
              for (const ring of rings(g)) out.areas.push({ id: id++, ring, cls, tag: `${layer}=${p.class ?? p.subclass ?? ""}` });
            });
          area("park", () => "green");
          area("landcover", (p) => (["grass", "wood", "farmland", "wetland", "sand"].includes(String(p.class)) ? "green" : null));
          area("landuse", (p) => {
            const c = String(p.class);
            if (c === "construction" || c === "brownfield") return "construction";
            if (c === "school") return "school";
            if (c === "pitch" || c === "playground" || c === "garden" || c === "cemetery") return "green";
            return null;
          });
          area("water", () => "water");
          each("waterway", (g, p) => {
            const cls = String(p.class ?? "stream");
            const width = cls === "river" ? 20 : cls === "canal" ? 8 : cls === "drain" ? 2.5 : cls === "ditch" ? 1.5 : 3;
            for (const pts of lines(g)) out.waterways.push({ id: id++, pts, kind: cls, width });
          });
        })(),
      );
  await Promise.all(jobs);
  return out;
}
