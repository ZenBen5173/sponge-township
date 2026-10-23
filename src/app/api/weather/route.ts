/**
 * MET Malaysia (data.gov.my) forecast and warnings for Klang, translated and rated for the
 * court-closing rule. Cached for 15 minutes; the last good answer is kept if the API is down.
 */
import { translate, WHEN, type DayForecast, type WarningItem, type WeatherPayload } from "@/lib/weather";

const API = "https://api.data.gov.my/weather";
let last: WeatherPayload | null = null;

interface RawDay {
  location: { location_id: string; location_name: string };
  date: string;
  morning_forecast: string;
  afternoon_forecast: string;
  night_forecast: string;
  summary_forecast: string;
  summary_when: string;
  min_temp: number;
  max_temp: number;
}
interface RawWarning {
  warning_issue: { issued: string; title_en: string; title_bm: string };
  valid_from: string | null;
  valid_to: string | null;
  heading_en: string | null;
  text_en: string | null;
}

function myt(): Date {
  return new Date(Date.now() + 8 * 3600e3); // shift to Malaysia time, then read with getUTC*
}

export async function GET(req: Request) {
  const loc = new URL(req.url).searchParams.get("location") ?? "Klang";
  try {
    const [fRes, wRes] = await Promise.all([
      fetch(`${API}/forecast/?contains=${encodeURIComponent(loc)}@location__location_name&sort=date`, { signal: AbortSignal.timeout(12000), next: { revalidate: 900 } }),
      fetch(`${API}/warning/?limit=20&sort=-warning_issue__issued`, { signal: AbortSignal.timeout(12000), next: { revalidate: 900 } }),
    ]);
    if (!fRes.ok) throw new Error(`forecast ${fRes.status}`);
    const raw = ((await fRes.json()) as RawDay[]).filter((d) => d.location.location_name.toLowerCase() === loc.toLowerCase());
    const now = myt();
    const today = now.toISOString().slice(0, 10);
    const days: DayForecast[] = raw
      .filter((d) => d.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 7)
      .map((d) => ({
        date: d.date,
        morning: { bm: d.morning_forecast, ...translate(d.morning_forecast) },
        afternoon: { bm: d.afternoon_forecast, ...translate(d.afternoon_forecast) },
        night: { bm: d.night_forecast, ...translate(d.night_forecast) },
        summary: { bm: d.summary_forecast, ...translate(d.summary_forecast) },
        when: WHEN[d.summary_when] ?? d.summary_when,
        min: d.min_temp,
        max: d.max_temp,
      }));
    let warnings: WarningItem[] = [];
    if (wRes.ok) {
      const nowIso = now.toISOString().slice(0, 19);
      warnings = ((await wRes.json()) as RawWarning[])
        .filter((w) => !w.valid_to || w.valid_to >= nowIso)
        .filter((w) => !/no advisory|tiada nasihat/i.test(w.warning_issue.title_en ?? ""))
        .map((w) => {
          const text = w.text_en ?? "";
          const land = /thunderstorm|heavy rain|continuous rain|ribut petir|hujan lebat/i.test(`${w.warning_issue.title_en} ${w.heading_en}`);
          const here = /selangor|klang/i.test(text) && !/waters of/i.test(text.split(/selangor/i)[0].slice(-40));
          return {
            issued: w.warning_issue.issued,
            title: w.warning_issue.title_en,
            heading: w.heading_en ?? "",
            text,
            validFrom: w.valid_from,
            validTo: w.valid_to,
            relevant: land && here && !/rough seas|strong wind/i.test(w.warning_issue.title_en ?? ""),
          };
        });
    }
    // Heavy rain expected: a relevant warning in force, or thunderstorms in today's afternoon/night forecast.
    const hour = now.getUTCHours();
    const d0 = days[0];
    let heavyReason: string | null = null;
    const rel = warnings.find((w) => w.relevant);
    if (rel) heavyReason = `MET Malaysia: ${rel.title}`;
    else if (d0) {
      const parts = [hour < 12 ? d0.morning : null, hour < 19 ? d0.afternoon : null, d0.night].filter(Boolean) as DayForecast["morning"][];
      const worst = parts.sort((a, b) => b.risk - a.risk)[0];
      if (worst && worst.risk >= 2) heavyReason = `Forecast for Klang today: ${worst.en.toLowerCase()}`;
    }
    const payload: WeatherPayload = {
      location: loc,
      fetchedAt: new Date().toISOString(),
      days,
      warnings: warnings.slice(0, 6),
      heavyExpected: !!heavyReason,
      heavyReason,
      source: "live",
    };
    last = payload;
    return Response.json(payload, { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" } });
  } catch (err) {
    if (last) return Response.json({ ...last, source: "cached" } satisfies WeatherPayload);
    return Response.json(
      { location: loc, fetchedAt: new Date().toISOString(), days: [], warnings: [], heavyExpected: false, heavyReason: null, source: "unavailable", error: (err as Error).message },
      { status: 200 },
    );
  }
}
