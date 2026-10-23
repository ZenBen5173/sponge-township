"use client";
import { strToU8, zipSync } from "fflate";
import { fmtDuration } from "@/components/ui/primitives";
import { getEngine } from "./engine";
import { fmtLatLon } from "./geo";
import type { Stats } from "./sim/types";
import { useApp } from "./store";

function dataUrlToU8(url: string): Uint8Array {
  const b64 = url.split(",")[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

async function loadImg(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

const pct = (a?: number, b?: number) => (a && b !== undefined && a > 0 ? ((b - a) / a) * 100 : null);

/** One 1920×1080 slide-ready image: before | after, with the headline numbers. */
async function composite(without: string, withD: string, base: Stats, design: Stats, title: string): Promise<Uint8Array> {
  const W = 1920;
  const H = 1080;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0b141d");
  bg.addColorStop(1, "#05080c");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const [a, b] = await Promise.all([loadImg(without), loadImg(withD)]);
  const pw = 920;
  const ph = 620;
  const top = 150;
  const draw = (img: HTMLImageElement, x: number, label: string, color: string) => {
    const s = Math.max(pw / img.width, ph / img.height);
    const sw = pw / s;
    const sh = ph / s;
    g.save();
    g.beginPath();
    g.roundRect(x, top, pw, ph, 18);
    g.clip();
    g.fillStyle = "#28394a";
    g.fillRect(x, top, pw, ph);
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, top, pw, ph);
    g.restore();
    g.fillStyle = color;
    g.font = "600 22px 'Instrument Sans', system-ui, sans-serif";
    g.beginPath();
    g.roundRect(x + 18, top + 18, g.measureText(label).width + 32, 40, 10);
    g.fill();
    g.fillStyle = color === "#5eead4" ? "#04201c" : "#ffffff";
    g.fillText(label, x + 34, top + 46);
  };
  draw(a, 40, "Without design", "rgba(0,0,0,0.6)");
  draw(b, 960, "With Sponge Township design", "#5eead4");
  g.fillStyle = "#e8eef3";
  g.font = "italic 56px 'Instrument Serif', Georgia, serif";
  g.fillText(title, 40, 90);
  g.fillStyle = "#8a9aab";
  g.font = "22px 'Instrument Sans', system-ui, sans-serif";
  g.fillText("Peak flood during the storm · Sponge Township flood simulator", 40, 126);
  const sq = design.features.find((f) => f.kind === "square");
  const cards: [string, string, string][] = [
    ["Peak street depth", `${base.peakStreetDepth.toFixed(2)} → ${design.peakStreetDepth.toFixed(2)} m`, fmtPct(pct(base.peakStreetDepth, design.peakStreetDepth))],
    ["Buildings with water at the door", `${base.peakBuildingsWet} → ${design.peakBuildingsWet}`, fmtPct(pct(base.peakBuildingsWet, design.peakBuildingsWet))],
    ["Street area > 15 cm deep", `${Math.round(base.peakFloodedRoadArea).toLocaleString()} → ${Math.round(design.peakFloodedRoadArea).toLocaleString()} m²`, fmtPct(pct(base.peakFloodedRoadArea, design.peakFloodedRoadArea))],
    ["Water square stored (peak)", sq ? `${Math.round(sq.peakStored).toLocaleString()} m³` : "—", sq ? `${Math.round((sq.peakStored / Math.max(1, sq.capacity)) * 100)}% of capacity` : ""],
  ];
  cards.forEach(([label, value, delta], k) => {
    const x = 40 + k * 465;
    const y = 800;
    g.fillStyle = "rgba(255,255,255,0.04)";
    g.strokeStyle = "rgba(148,178,204,0.2)";
    g.beginPath();
    g.roundRect(x, y, 445, 200, 18);
    g.fill();
    g.stroke();
    g.fillStyle = "#8a9aab";
    g.font = "20px 'Instrument Sans', system-ui, sans-serif";
    g.fillText(label.toUpperCase(), x + 24, y + 44);
    g.fillStyle = "#e8eef3";
    g.font = "600 40px 'JetBrains Mono', monospace";
    g.fillText(value, x + 24, y + 110, 400);
    g.fillStyle = "#5eead4";
    g.font = "26px 'JetBrains Mono', monospace";
    g.fillText(delta, x + 24, y + 160);
  });
  return dataUrlToU8(c.toDataURL("image/png"));
}

function fmtPct(p: number | null) {
  if (p === null || !Number.isFinite(p)) return "";
  return `${p > 0 ? "+" : ""}${p.toFixed(0)}%`;
}

export function summaryMarkdown(): string {
  const s = useApp.getState();
  const base = s.finals.base ?? s.stats.base;
  const design = s.finals.design ?? s.stats.design;
  const st = s.storm;
  const lines: string[] = [];
  lines.push(`# Sponge Township — flood simulation summary`, "");
  lines.push(`- **Area:** ${s.area.label ?? "Custom area"} (${fmtLatLon(s.area.lat, s.area.lon)}), ${s.area.size} m × ${s.area.size} m`);
  lines.push(`- **Storm:** ${st.totalMm} mm over ${fmtDuration(st.durationMin * 60)} (${st.shape === "thunderstorm" ? "front-loaded thunderstorm" : "steady"}), high tide ${st.highTide ? "on" : "off"}`);
  lines.push(`- **Existing drains:** ${s.params.drainMmPerHour} mm/h over the area${st.highTide ? `, ${Math.round(s.params.tideFactor * 100)}% at high tide` : ""}`);
  lines.push(`- **Flooded building threshold:** ${Math.round(s.params.buildingThreshold * 100)} cm of water at the building edge`, "");
  if (base && design) {
    lines.push(`| Measure | Without | With design | Change |`, `|---|---:|---:|---:|`);
    const row = (l: string, a: number, b: number, d: number, u: string) => lines.push(`| ${l} | ${a.toFixed(d)} ${u} | ${b.toFixed(d)} ${u} | ${fmtPct(pct(a, b))} |`);
    row("Peak street water depth", base.peakStreetDepth, design.peakStreetDepth, 2, "m");
    row("Buildings with water at the door", base.peakBuildingsWet, design.peakBuildingsWet, 0, "");
    row("Street area under > 15 cm", base.peakFloodedRoadArea, design.peakFloodedRoadArea, 0, "m²");
    lines.push("");
  } else if (base ?? design) {
    const x = (base ?? design)!;
    lines.push(`Peak street depth ${x.peakStreetDepth.toFixed(2)} m · ${x.peakBuildingsWet} buildings with water at the door · ${Math.round(x.peakFloodedRoadArea)} m² of street under 15 cm+`, "");
  }
  if (design) {
    lines.push(`## Features`, "");
    for (const f of design.features) {
      if (f.kind === "square") {
        const empty = f.emptyAt != null ? fmtDuration(f.emptyAt - st.durationMin * 60) : f.projectedEmpty != null ? `~${fmtDuration(Math.max(0, design.t - st.durationMin * 60) + f.projectedEmpty)} (projected)` : "blocked";
        lines.push(`- **${f.name}:** peak ${Math.round(f.peakStored)} m³ of ${Math.round(f.capacity)} m³ (${Math.round((f.peakStored / f.capacity) * 100)}%), empty ${empty} after the rain stopped`);
      } else if (f.captured !== undefined) lines.push(`- **${f.name}:** caught ${Math.round(f.captured)} m³`);
      else lines.push(`- **${f.name}:** stored up to ${Math.round(f.peakStored)} m³ (capacity ${Math.round(f.capacity)} m³)`);
    }
    lines.push("");
  }
  const b = (design ?? base)?.balance;
  if (b) {
    lines.push(`## Water balance (${design ? "with design" : "as is"})`, "");
    lines.push(`Rain in ${Math.round(b.rain)} m³ = on the ground ${Math.round(b.surface)} + in features ${Math.round(b.featureStore)} + soaked in ${Math.round(b.infiltrated)} + drained ${Math.round(b.drained)} + left the area ${Math.round(b.leftArea)} m³ (error ${(Math.abs(b.error) * 100).toExponential(1)}%).`, "");
  }
  lines.push(`_Model: 2-D local-inertial shallow-water solver on a ${s.scene?.grid.nx}×${s.scene?.grid.ny} grid of ${s.scene?.grid.dx.toFixed(1)} m cells. Terrain AWS Terrain Tiles (SRTM-based, ~30 m), imagery Esri World Imagery, buildings/roads © OpenStreetMap contributors (ODbL). Indicative, not a design calculation._`);
  return lines.join("\n");
}

function csv(): string {
  const s = useApp.getState();
  const h = s.history;
  const rows = ["t_min,rain_mm_h,street_depth_without_m,street_depth_with_m,buildings_without,buildings_with,square_level_m,square_fill"];
  h.t.forEach((t, k) =>
    rows.push([(t / 60).toFixed(1), h.rain[k].toFixed(1), h.baseStreet[k], h.designStreet[k], h.baseBuildings[k], h.designBuildings[k], h.level[k], h.fill[k]].map((v) => (typeof v === "number" && Number.isNaN(v) ? "" : String(v))).join(",")),
  );
  return rows.join("\n");
}

function download(name: string, data: Uint8Array | string, type: string) {
  const blob = new Blob([typeof data === "string" ? data : (data as BlobPart)], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function exportPack() {
  const s = useApp.getState();
  const eng = getEngine();
  const r = eng.scene3d;
  if (!r) return;
  const files: Record<string, Uint8Array> = {};
  let snap = s.snapshot;
  if (!snap.with) {
    // no finished run: capture what is on screen now
    snap = { without: r.capture("without"), with: s.features.length ? r.capture("with") : undefined, split: s.features.length ? r.capture("split") : undefined };
  }
  if (snap.without) files["1-without-design.png"] = dataUrlToU8(snap.without);
  if (snap.with) files["2-with-design.png"] = dataUrlToU8(snap.with);
  if (snap.split) files["3-split-view.png"] = dataUrlToU8(snap.split);
  const base = s.finals.base ?? s.stats.base;
  const design = s.finals.design ?? s.stats.design;
  if (snap.without && snap.with && base && design) files["0-comparison-slide.png"] = await composite(snap.without, snap.with, base, design, s.area.label?.split(",")[0] ?? "Sponge Township");
  files["summary.md"] = strToU8(summaryMarkdown());
  files["timeseries.csv"] = strToU8(csv());
  files["results.json"] = strToU8(JSON.stringify({ area: s.area, storm: s.storm, params: s.params, features: s.features, without: base, with: design }, null, 2));
  const zip = zipSync(files, { level: 6 });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  download(`sponge-township-${stamp}.zip`, zip, "application/zip");
}
