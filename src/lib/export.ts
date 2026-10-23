"use client";
import { strToU8, zipSync } from "fflate";
import { fmtDuration } from "@/components/ui/primitives";
import { getEngine } from "./engine";
import { fmtLatLon } from "./geo";
import type { Stats } from "./sim/types";
import { type NearStats, useApp } from "./store";

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
async function composite(without: string, withD: string, base: Stats, design: Stats, title: string, near: { base?: NearStats; design?: NearStats }): Promise<Uint8Array> {
  const W = 1920;
  const H = 1080;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // next/font gives each family a hashed name; read it back from the CSS variables
  const css = getComputedStyle(document.body);
  const fam = (v: string, fb: string) => `${css.getPropertyValue(v).trim() || fb}, ${fb}`;
  const display = fam("--font-space-grotesk", "system-ui, sans-serif");
  const mono = fam("--font-space-mono", "monospace");
  const hand = fam("--font-caveat", "cursive");
  const INK = "#161514";
  const MUTED = "#6b665e";
  g.fillStyle = "#f7f5ef";
  g.fillRect(0, 0, W, H);
  const card = (x: number, y: number, w: number, h: number, r: number, fill: string, shadow = INK) => {
    g.fillStyle = shadow;
    g.beginPath();
    g.roundRect(x + 7, y + 7, w, h, r);
    g.fill();
    g.fillStyle = fill;
    g.strokeStyle = INK;
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
    g.stroke();
  };
  const stamp = (text: string, x: number, y: number, color: string) => {
    g.save();
    g.translate(x, y);
    g.rotate(-0.07);
    g.font = `700 28px ${mono}`;
    const w = g.measureText(text).width + 28;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 3.5;
    g.beginPath();
    g.roundRect(0, -32, w, 44, 8);
    g.stroke();
    g.fillText(text, 14, 0);
    g.restore();
  };
  const [a, b] = await Promise.all([loadImg(without), loadImg(withD)]);
  const pw = 900;
  const ph = 600;
  const top = 160;
  const draw = (img: HTMLImageElement, x: number, label: string, chip: string, shadow: string) => {
    const s = Math.max(pw / img.width, ph / img.height);
    const sw = pw / s;
    const sh = ph / s;
    card(x, top, pw, ph, 20, "#efebe2", shadow);
    g.save();
    g.beginPath();
    g.roundRect(x + 1.5, top + 1.5, pw - 3, ph - 3, 19);
    g.clip();
    g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, top, pw, ph);
    g.restore();
    g.font = `700 20px ${mono}`;
    const lw = g.measureText(label).width + 32;
    g.fillStyle = INK;
    g.beginPath();
    g.roundRect(x + 22, top + 22, lw, 42, 10);
    g.fill();
    g.fillStyle = chip;
    g.beginPath();
    g.roundRect(x + 18, top + 18, lw, 42, 10);
    g.fill();
    g.strokeStyle = INK;
    g.lineWidth = 2.5;
    g.stroke();
    g.fillStyle = chip === "#ffffff" ? INK : "#ffffff";
    g.fillText(label, x + 34, top + 46);
  };
  draw(a, 40, "WITHOUT DESIGN", "#ffffff", "#ff5a36");
  draw(b, 970, "WITH THE SPONGE DESIGN", "#3d6cf5", "#3d6cf5");
  g.fillStyle = "#ff5a36";
  g.font = `700 18px ${mono}`;
  g.fillText("PEAK FLOOD · SPONGE TOWNSHIP FLOOD SIMULATOR", 40, 62);
  g.fillStyle = INK;
  g.font = `700 60px ${display}`;
  g.fillText(title, 40, 126, 1500);
  g.save();
  g.translate(W - 44, 118);
  g.rotate(-0.05);
  g.fillStyle = "#c8381a";
  g.font = `700 40px ${hand}`;
  g.textAlign = "right";
  g.fillText("same storm, two towns ↓", 0, 0);
  g.restore();
  const sq = design.features.find((f) => f.kind === "square");
  const nb = near.base;
  const nd = near.design;
  const cards: [string, string, number | null, string][] = [
    nb && nd
      ? ["Deepest street within 150 m", `${nb.peakDepth.toFixed(2)} → ${nd.peakDepth.toFixed(2)} m`, pct(nb.peakDepth, nd.peakDepth), ""]
      : ["Peak street depth", `${base.peakStreetDepth.toFixed(2)} → ${design.peakStreetDepth.toFixed(2)} m`, pct(base.peakStreetDepth, design.peakStreetDepth), ""],
    ["Homes with water at the door", `${base.peakBuildingsWet} → ${design.peakBuildingsWet}`, pct(base.peakBuildingsWet, design.peakBuildingsWet), ""],
    ["Street area > 15 cm deep", `${Math.round(base.peakFloodedRoadArea).toLocaleString()} → ${Math.round(design.peakFloodedRoadArea).toLocaleString()} m²`, pct(base.peakFloodedRoadArea, design.peakFloodedRoadArea), ""],
    ["Water square stored (peak)", sq ? `${Math.round(sq.peakStored).toLocaleString()} m³` : "—", null, sq ? `${Math.round((sq.peakStored / Math.max(1, sq.capacity)) * 100)}% FULL` : ""],
  ];
  cards.forEach(([label, value, p, note], k) => {
    const x = 40 + k * 462;
    const y = 818;
    card(x, y, 430, 200, 18, k === 3 ? "#dbe6ff" : "#ffffff");
    g.fillStyle = MUTED;
    g.font = `700 17px ${mono}`;
    g.fillText(label.toUpperCase(), x + 24, y + 46, 390);
    g.fillStyle = INK;
    g.font = `700 38px ${mono}`;
    g.fillText(value, x + 24, y + 108, 390);
    const d = fmtPct(p);
    if (d) stamp(d, x + 24, y + 166, p! < -0.5 ? "#2f8f46" : p! > 0.5 ? "#ff5a36" : INK);
    else if (note) stamp(note, x + 24, y + 166, "#1f3fb0");
  });
  return dataUrlToU8(c.toDataURL("image/png"));
}

function fmtPct(p: number | null) {
  if (p === null || !Number.isFinite(p)) return "";
  if (Math.abs(p) < 0.5) return "±0%";
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
    const nb = s.near.base;
    const nd = s.near.design;
    if (nb && nd) {
      row("Within 150 m of the design: deepest street", nb.peakDepth, nd.peakDepth, 2, "m");
      row(`Within 150 m: homes with water at the door (of ${nb.buildings})`, nb.buildingsWet, nd.buildingsWet, 0, "");
      row("Within 150 m: street area under > 15 cm", nb.floodedRoadArea, nd.floodedRoadArea, 0, "m²");
    }
    lines.push("", "_All values are the worst moment of each run (peak over the storm and the drain-down)._", "");
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
  if (snap.without && snap.with && base && design)
    files["0-comparison-slide.png"] = await composite(snap.without, snap.with, base, design, s.area.label?.split(",")[0] ?? "Sponge Township", s.near);
  files["summary.md"] = strToU8(summaryMarkdown());
  files["timeseries.csv"] = strToU8(csv());
  files["results.json"] = strToU8(JSON.stringify({ area: s.area, storm: s.storm, params: s.params, features: s.features, without: base, with: design }, null, 2));
  const zip = zipSync(files, { level: 6 });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  download(`sponge-township-${stamp}.zip`, zip, "application/zip");
}
