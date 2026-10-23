/** MET Malaysia forecast phrases are Malay-only fixed values; translate and rate them. */
const PHRASES: [RegExp, string, number][] = [
  [/tiada hujan/i, "No rain", 0],
  [/ribut petir di kebanyakan tempat/i, "Widespread thunderstorms", 3],
  [/ribut petir di beberapa tempat/i, "Scattered thunderstorms", 2],
  [/ribut petir di satu dua tempat/i, "Isolated thunderstorms", 2],
  [/ribut petir/i, "Thunderstorms", 2],
  [/hujan menyeluruh/i, "Widespread rain", 2],
  [/hujan di kebanyakan tempat/i, "Rain in most places", 2],
  [/hujan di beberapa tempat/i, "Scattered rain", 1],
  [/hujan di satu dua tempat/i, "Isolated rain", 1],
  [/hujan/i, "Rain", 1],
  [/berjerebu|jerebu/i, "Hazy", 0],
  [/mendung/i, "Cloudy", 0],
  [/berangin/i, "Windy", 0],
];

export function translate(bm: string | null | undefined): { en: string; risk: number } {
  if (!bm) return { en: "—", risk: 0 };
  for (const [re, en, risk] of PHRASES) if (re.test(bm)) return { en, risk };
  return { en: bm, risk: 0 };
}

export const WHEN: Record<string, string> = {
  Pagi: "Morning",
  Petang: "Afternoon",
  Malam: "Night",
  "Pagi dan Petang": "Morning & afternoon",
  "Petang dan Malam": "Afternoon & night",
  "Pagi dan Malam": "Morning & night",
  "Sepanjang Hari": "All day",
  "Tiada": "—",
};

export interface DayForecast {
  date: string;
  morning: { bm: string; en: string; risk: number };
  afternoon: { bm: string; en: string; risk: number };
  night: { bm: string; en: string; risk: number };
  summary: { bm: string; en: string; risk: number };
  when: string;
  min: number;
  max: number;
}

export interface WarningItem {
  issued: string;
  title: string;
  heading: string;
  text: string;
  validFrom: string | null;
  validTo: string | null;
  relevant: boolean;
}

export interface WeatherPayload {
  location: string;
  fetchedAt: string;
  days: DayForecast[];
  warnings: WarningItem[];
  heavyExpected: boolean;
  heavyReason: string | null;
  source: "live" | "cached" | "unavailable";
}
