import { type BBox, bboxContains } from "../geo";

export type LL = [number, number]; // [lat, lon]

export interface OsmBuilding {
  id: number;
  ring: LL[];
  height: number;
  kind: string;
  name?: string;
}
export interface OsmRoad {
  id: number;
  pts: LL[];
  kind: string;
  width: number;
  name?: string;
}
export type AreaClass = "green" | "water" | "paved" | "construction" | "school" | "other";
export interface OsmArea {
  id: number;
  ring: LL[];
  cls: AreaClass;
  tag: string;
  name?: string;
}
export interface OsmWaterway {
  id: number;
  pts: LL[];
  kind: string;
  width: number;
  name?: string;
}
export interface OsmData {
  buildings: OsmBuilding[];
  roads: OsmRoad[];
  areas: OsmArea[];
  waterways: OsmWaterway[];
  source: "live" | "baked" | "tiles" | "none";
}

/** Carriageway widths including kerb and roadside drain (m), typical Malaysian township streets. */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 24,
  trunk: 20,
  primary: 16,
  secondary: 14,
  tertiary: 12,
  tertiary_link: 8,
  secondary_link: 8,
  primary_link: 9,
  unclassified: 8,
  residential: 7,
  living_street: 6,
  service: 5,
  footway: 2,
  path: 2,
  cycleway: 2.5,
  pedestrian: 4,
  track: 3,
};

const GREEN_TAGS = new Set([
  "landuse=grass",
  "landuse=greenfield",
  "landuse=recreation_ground",
  "landuse=meadow",
  "landuse=village_green",
  "landuse=forest",
  "landuse=farmland",
  "landuse=orchard",
  "landuse=plant_nursery",
  "landuse=brownfield",
  "leisure=park",
  "leisure=pitch",
  "leisure=playground",
  "leisure=garden",
  "leisure=common",
  "leisure=recreation_ground",
  "natural=grassland",
  "natural=scrub",
  "natural=grass",
  "natural=wood",
  "natural=heath",
]);

// Baked copy of the default area, fetched from Overpass on 20 Oct 2026 (see scripts/bake.mjs).
export const BAKED_OSM_BBOX: BBox = { s: 3.094, w: 101.409, n: 3.103, e: 101.418 };

interface El {
  type: "way" | "relation" | "node";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

function joinRings(segs: LL[][]): LL[][] {
  const rings: LL[][] = [];
  const pool = segs.filter((s) => s.length > 1).map((s) => [...s]);
  const same = (a: LL, b: LL) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let ring = pool.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let k = 0; k < pool.length; k++) {
        const s = pool[k];
        const end = ring[ring.length - 1];
        if (same(end, s[0])) ring = ring.concat(s.slice(1));
        else if (same(end, s[s.length - 1])) ring = ring.concat([...s].reverse().slice(1));
        else continue;
        pool.splice(k, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function heightOf(t: Record<string, string>): number {
  const h = parseFloat(t.height ?? "");
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(t["building:levels"] ?? "");
  if (Number.isFinite(lv) && lv > 0) return lv * 3.2 + 1;
  const b = t.building;
  if (b === "apartments" || b === "residential") return 30;
  if (b === "commercial" || b === "retail" || b === "office") return 12;
  if (b === "industrial" || b === "warehouse") return 9;
  if (b === "school") return 12;
  if (b === "roof" || b === "shed" || b === "garage") return 3;
  return 7.5; // two-storey terrace house, the commonest building in Bandar Bukit Raja
}

export function parseOverpass(json: { elements: El[] }, source: OsmData["source"]): OsmData {
  const out: OsmData = { buildings: [], roads: [], areas: [], waterways: [], source };
  for (const el of json.elements ?? []) {
    const t = el.tags ?? {};
    let rings: LL[][] = [];
    if (el.type === "way" && el.geometry) {
      const g = el.geometry.map((p) => [p.lat, p.lon] as LL);
      const closed = g.length > 3 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];
      if (t.highway && !closed) {
        const kind = t.highway;
        if (ROAD_WIDTH[kind] !== undefined || kind.endsWith("_link")) {
          const lanes = parseFloat(t.lanes ?? "");
          let width = ROAD_WIDTH[kind] ?? 8;
          if (Number.isFinite(lanes) && lanes > 0 && kind !== "footway") width = Math.max(width, lanes * 3.3 + 2);
          out.roads.push({ id: el.id, pts: g, kind, width, name: t.name });
        }
        continue;
      }
      if (t.highway && closed && t.area !== "yes") {
        out.roads.push({ id: el.id, pts: g, kind: t.highway, width: ROAD_WIDTH[t.highway] ?? 6, name: t.name });
        continue;
      }
      if (t.waterway && !closed) {
        const kind = t.waterway;
        const width = kind === "river" ? 20 : kind === "canal" ? 8 : kind === "drain" ? 2.5 : kind === "ditch" ? 1.5 : 3;
        out.waterways.push({ id: el.id, pts: g, kind, width, name: t.name });
        continue;
      }
      if (closed) rings = [g];
    } else if (el.type === "relation" && el.members) {
      rings = joinRings(el.members.filter((m) => m.role === "outer" && m.geometry).map((m) => m.geometry!.map((p) => [p.lat, p.lon] as LL)));
    }
    if (!rings.length) continue;
    for (const ring of rings) {
      if (t.building && t.building !== "no") {
        out.buildings.push({ id: el.id, ring, height: heightOf(t), kind: t.building, name: t.name });
        continue;
      }
      const tag = ["landuse", "leisure", "natural", "amenity"].map((k) => (t[k] ? `${k}=${t[k]}` : "")).find(Boolean) ?? "";
      let cls: AreaClass = "other";
      if (GREEN_TAGS.has(tag)) cls = "green";
      else if (tag === "natural=water" || tag === "landuse=basin" || tag === "landuse=reservoir" || t.water) cls = "water";
      else if (tag === "amenity=parking" || tag === "leisure=sports_centre") cls = "paved";
      else if (tag === "landuse=construction") cls = "construction";
      else if (tag === "amenity=school") cls = "school";
      if (cls === "other" && !tag.startsWith("landuse=")) continue;
      out.areas.push({ id: el.id, ring, cls, tag, name: t.name });
    }
  }
  return out;
}

/**
 * Load OpenStreetMap features for a bbox: the baked default area first; otherwise ask the Overpass
 * proxy and the OpenFreeMap vector tiles at the same time, and take Overpass (richer tags) if it
 * answers within 12 s, else the tiles.
 */
export async function loadOsm(bbox: BBox): Promise<{ data: OsmData; warning?: string }> {
  if (bboxContains(BAKED_OSM_BBOX, bbox)) {
    try {
      const res = await fetch("/baked/casira-osm.json");
      if (res.ok) return { data: parseOverpass(await res.json(), "baked") };
    } catch {
      /* fall through to live */
    }
  }
  const q = [bbox.s, bbox.w, bbox.n, bbox.e].map((v) => v.toFixed(6)).join(",");
  const overpass = (async () => {
    const res = await fetch(`/api/osm?bbox=${q}`, { signal: AbortSignal.timeout(110_000) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return parseOverpass(json, "live");
  })();
  const tiles = import("./vectortiles").then((m) => m.loadOsmFromTiles(bbox, AbortSignal.timeout(30_000)));
  overpass.catch(() => {});
  tiles.catch(() => {});
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 12_000));
  const first = await Promise.race([overpass.catch(() => null), timeout]);
  if (first) return { data: first };
  try {
    const t = await tiles;
    t.source = "tiles";
    return { data: t };
  } catch {
    try {
      return { data: await overpass };
    } catch (err) {
      return {
        data: { buildings: [], roads: [], areas: [], waterways: [], source: "none" },
        warning: `Buildings and roads could not be loaded (${(err as Error).message}). Terrain and imagery only — try again in a minute.`,
      };
    }
  }
}
