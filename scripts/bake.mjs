// Bakes a fallback copy of the default demo area (Casira, Bandar Bukit Raja) into public/baked,
// so the demo works even if Overpass, AWS or Esri are down on the day.
//   node scripts/bake.mjs
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";

const BBOX = { s: 3.094, w: 101.409, n: 3.103, e: 101.418 };
const OUT = join(process.cwd(), "public", "baked");
const UA = "sponge-township/1.0 (SDP Hackathon 2026 flood prototype; +https://github.com/sponge-township)";

const lonToTile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTile = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
};

async function save(path, buf) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function tiles(kind, z, url, ext) {
  const x0 = lonToTile(BBOX.w, z), x1 = lonToTile(BBOX.e, z);
  const y0 = latToTile(BBOX.n, z), y1 = latToTile(BBOX.s, z);
  let n = 0;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const p = join(OUT, "tiles", kind, String(z), String(x), `${y}.${ext}`);
      if (await exists(p)) continue;
      const res = await fetch(url(z, x, y), { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`${res.status} ${url(z, x, y)}`);
      await save(p, Buffer.from(await res.arrayBuffer()));
      n++;
    }
  console.log(`${kind} z${z}: ${(x1 - x0 + 1) * (y1 - y0 + 1)} tiles (${n} new)`);
}

async function osm() {
  const p = join(OUT, "casira-osm.json");
  if (await exists(p)) return console.log("osm: exists");
  const b = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;
  const q = `[out:json][timeout:90];(way["building"](${b});relation["building"](${b});way["highway"](${b});way["landuse"](${b});relation["landuse"](${b});way["leisure"](${b});relation["leisure"](${b});way["natural"](${b});relation["natural"](${b});way["amenity"~"parking|school|place_of_worship|community_centre"](${b});way["waterway"](${b}););out geom tags;`;
  for (let i = 0; i < 6; i++) {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: q }),
    });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith("{")) {
      await save(p, text);
      return console.log("osm: saved", text.length);
    }
    await new Promise((r) => setTimeout(r, 3000 * 2 ** i));
  }
  throw new Error("overpass unavailable");
}

await osm();
await tiles("terrain", 15, (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, "png");
for (const z of [17, 18])
  await tiles("imagery", z, (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, "jpg");
