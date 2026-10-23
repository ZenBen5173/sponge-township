/**
 * Sime Darby Property townships (simedarbyproperty.com, Oct 2026) and the earlier Sime UEP / Guthrie
 * townships still under its name. Centres are OpenStreetMap place points (via Photon), so each box
 * opens on the township's built-up core; drag the box to look elsewhere in a large township.
 */
export interface Township {
  id: string;
  name: string;
  town: string;
  state: string;
  region: "Klang" | "Shah Alam" | "Petaling & Subang" | "Kuala Lumpur" | "Sepang" | "Negeri Sembilan" | "Johor";
  lat: number;
  lon: number;
  /** box side to open with, m */
  size: number;
  note?: string;
}

export const TOWNSHIPS: Township[] = [
  { id: "bbr-casira", name: "Bandar Bukit Raja · Casira", town: "Klang", state: "Selangor", region: "Klang", lat: 3.0985, lon: 101.4135, size: 500, note: "Default · flooded 4 Jun 2023" },
  { id: "bbr-centre", name: "Bandar Bukit Raja · town centre", town: "Klang", state: "Selangor", region: "Klang", lat: 3.0852, lon: 101.4377, size: 700 },
  { id: "elmina", name: "City of Elmina", town: "Shah Alam", state: "Selangor", region: "Shah Alam", lat: 3.1804, lon: 101.5173, size: 800, note: "SDP's largest township" },
  { id: "denai-alam", name: "Denai Alam", town: "Shah Alam", state: "Selangor", region: "Shah Alam", lat: 3.1636, lon: 101.513, size: 700 },
  { id: "bukit-jelutong", name: "Bukit Jelutong", town: "Shah Alam", state: "Selangor", region: "Shah Alam", lat: 3.1002, lon: 101.5375, size: 800 },
  { id: "ara-damansara", name: "Ara Damansara", town: "Petaling Jaya", state: "Selangor", region: "Petaling & Subang", lat: 3.114, lon: 101.5803, size: 700 },
  { id: "sjcc", name: "Subang Jaya City Centre (SJCC)", town: "Subang Jaya", state: "Selangor", region: "Petaling & Subang", lat: 3.084, lon: 101.588, size: 600 },
  { id: "sj7", name: "SJ7", town: "Subang Jaya", state: "Selangor", region: "Petaling & Subang", lat: 3.0522, lon: 101.593, size: 500 },
  { id: "usj-heights", name: "USJ Heights", town: "Subang Jaya", state: "Selangor", region: "Petaling & Subang", lat: 3.0589, lon: 101.5643, size: 600 },
  { id: "putra-heights", name: "Putra Heights", town: "Subang Jaya", state: "Selangor", region: "Petaling & Subang", lat: 2.9937, lon: 101.5734, size: 800 },
  { id: "kl-east", name: "KL East", town: "Kuala Lumpur", state: "Kuala Lumpur", region: "Kuala Lumpur", lat: 3.2266, lon: 101.7319, size: 700 },
  { id: "melawati", name: "Melawati", town: "Ulu Klang", state: "Kuala Lumpur", region: "Kuala Lumpur", lat: 3.2134, lon: 101.752, size: 700 },
  { id: "klgcc", name: "KLGCC Resort", town: "Bukit Kiara", state: "Kuala Lumpur", region: "Kuala Lumpur", lat: 3.1405, lon: 101.643, size: 700 },
  { id: "serenia", name: "Serenia City", town: "Sepang", state: "Selangor", region: "Sepang", lat: 2.8458, lon: 101.6981, size: 800 },
  { id: "nilai-impian", name: "Nilai Impian", town: "Nilai", state: "Negeri Sembilan", region: "Negeri Sembilan", lat: 2.8385, lon: 101.8071, size: 800 },
  { id: "planters-haven", name: "Planters' Haven", town: "Nilai", state: "Negeri Sembilan", region: "Negeri Sembilan", lat: 2.7935, lon: 101.8052, size: 700 },
  { id: "ainsdale", name: "Bandar Ainsdale", town: "Seremban", state: "Negeri Sembilan", region: "Negeri Sembilan", lat: 2.7304, lon: 101.8882, size: 800 },
  { id: "chemara", name: "Chemara Hills", town: "Seremban", state: "Negeri Sembilan", region: "Negeri Sembilan", lat: 2.7185, lon: 101.9284, size: 500 },
  { id: "pagoh", name: "Bandar Universiti Pagoh", town: "Muar", state: "Johor", region: "Johor", lat: 2.1531, lon: 102.7304, size: 900 },
  { id: "pasir-putih", name: "Taman Pasir Putih", town: "Pasir Gudang", state: "Johor", region: "Johor", lat: 1.4729, lon: 103.9389, size: 700 },
];

/** Townships matching a query (name, town, state or region), best matches first. */
export function searchTownships(q: string): Township[] {
  const s = q.trim().toLowerCase();
  if (!s) return TOWNSHIPS;
  const words = s.split(/\s+/);
  const scored = TOWNSHIPS.map((t) => {
    const hay = `${t.name} ${t.town} ${t.state} ${t.region}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return null;
    const score = t.name.toLowerCase().startsWith(s) ? 0 : t.name.toLowerCase().includes(s) ? 1 : 2;
    return { t, score };
  }).filter((x): x is { t: Township; score: number } => !!x);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.t);
}
