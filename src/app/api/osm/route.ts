/**
 * OpenStreetMap proxy. The public Overpass servers refuse browser-style and anonymous requests
 * (HTTP 406) and are often at capacity, so the app asks this route, which sends a descriptive
 * User-Agent, asks three mirrors at once (first good answer wins, the rest are cancelled), retries
 * once, and lets the CDN cache the answer for a day.
 */
export const maxDuration = 120;

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const UA = "sponge-township/1.0 (SDP Hackathon 2026 flood prototype; +https://sponge-township.vercel.app)";

const memo = new Map<string, { at: number; body: string }>();

function query(s: number, w: number, n: number, e: number) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:60];(
way["building"](${b});relation["building"](${b});
way["highway"](${b});
way["landuse"](${b});relation["landuse"](${b});
way["leisure"](${b});relation["leisure"](${b});
way["natural"](${b});relation["natural"](${b});
way["amenity"~"parking|school|place_of_worship|community_centre"](${b});
way["waterway"](${b});
);out geom tags;`;
}

async function ask(mirror: string, body: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(mirror, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal,
  });
  const text = await res.text();
  if (!res.ok || !text.trimStart().startsWith("{")) throw new Error(`${new URL(mirror).host} ${res.status}`);
  return text;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parts = (url.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    return Response.json({ error: "bbox=s,w,n,e required" }, { status: 400 });
  }
  const [s, w, n, e] = parts;
  if (n - s > 0.05 || e - w > 0.05) return Response.json({ error: "area too large" }, { status: 400 });
  const key = parts.map((v) => v.toFixed(5)).join(",");
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 864e5) return new Response(hit.body, { headers: headers() });

  const body = new URLSearchParams({ data: query(s, w, n, e) }).toString();
  const errors: string[] = [];
  for (let round = 0; round < 2; round++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    try {
      const text = await Promise.any(MIRRORS.map((m) => ask(m, body, ctl.signal)));
      memo.set(key, { at: Date.now(), body: text });
      return new Response(text, { headers: headers() });
    } catch (err) {
      const list = err instanceof AggregateError ? err.errors : [err];
      errors.push(...list.map((x) => (x as Error).message));
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return Response.json({ error: `OpenStreetMap is busy (${[...new Set(errors)].slice(0, 3).join("; ")})` }, { status: 503 });
}

function headers() {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
  };
}
