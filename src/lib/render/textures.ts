"use client";
import * as THREE from "three";

/** Sunken court floor: a basketball / multi-use court seen from above, drawn once. */
export function courtTexture(w: number, l: number): THREE.CanvasTexture {
  const px = 512;
  const c = document.createElement("canvas");
  const ratio = l / w;
  c.width = px;
  c.height = Math.round(px * Math.max(0.3, Math.min(3, ratio)));
  const g = c.getContext("2d")!;
  const W = c.width;
  const H = c.height;
  g.fillStyle = "#c8693f"; // terracotta run-off
  g.fillRect(0, 0, W, H);
  const m = W * 0.08;
  g.fillStyle = "#2f6f8f"; // court
  g.fillRect(m, m, W - 2 * m, H - 2 * m);
  g.strokeStyle = "rgba(255,255,255,0.92)";
  g.lineWidth = W * 0.008;
  g.strokeRect(m, m, W - 2 * m, H - 2 * m);
  const long = W > H;
  g.beginPath();
  if (long) {
    g.moveTo(W / 2, m);
    g.lineTo(W / 2, H - m);
  } else {
    g.moveTo(m, H / 2);
    g.lineTo(W - m, H / 2);
  }
  g.stroke();
  g.beginPath();
  g.arc(W / 2, H / 2, Math.min(W, H) * 0.11, 0, Math.PI * 2);
  g.stroke();
  // keys and three-point arcs
  const keyW = (long ? H : W) * 0.3;
  const keyL = (long ? W : H) * 0.17;
  for (const end of [0, 1]) {
    g.beginPath();
    if (long) {
      const x = end ? W - m : m;
      const dir = end ? -1 : 1;
      g.rect(Math.min(x, x + dir * keyL), H / 2 - keyW / 2, keyL, keyW);
      g.moveTo(x, H / 2 - H * 0.36);
      g.arc(x + dir * keyL * 0.3, H / 2, H * 0.36, end ? Math.PI * 0.5 : -Math.PI * 0.5, end ? Math.PI * 1.5 : Math.PI * 0.5, false);
    } else {
      const y = end ? H - m : m;
      const dir = end ? -1 : 1;
      g.rect(W / 2 - keyW / 2, Math.min(y, y + dir * keyL), keyW, keyL);
      g.moveTo(W / 2 + W * 0.36, y);
      g.arc(W / 2, y + dir * keyL * 0.3, W * 0.36, end ? Math.PI : 0, end ? 0 : Math.PI, false);
    }
    g.stroke();
  }
  // drainage channel round the edge and outlet grate
  g.strokeStyle = "rgba(30,30,30,0.55)";
  g.lineWidth = W * 0.012;
  g.strokeRect(m * 0.4, m * 0.4, W - m * 0.8, H - m * 0.8);
  g.fillStyle = "#1d1d1d";
  g.fillRect(W - m * 0.9, H - m * 0.9, m * 0.7, m * 0.7);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function paverTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b9ab8e";
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 4; x++) {
      const off = y % 2 ? 16 : 0;
      const shade = 170 + ((x * 7 + y * 13) % 5) * 9;
      g.fillStyle = `rgb(${shade},${shade - 12},${shade - 34})`;
      g.fillRect(((x * 32 + off) % 128) + 1.5, y * 16 + 1.5, 29, 13);
    }
  // green joints = permeable gaps
  g.strokeStyle = "rgba(70,110,60,0.6)";
  g.lineWidth = 1.2;
  for (let y = 0; y <= 8; y++) {
    g.beginPath();
    g.moveTo(0, y * 16);
    g.lineTo(128, y * 16);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function grateTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2a2d30";
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = "#0b0d0f";
  for (let x = 2; x < 64; x += 5) g.fillRect(x, 3, 2.4, 10);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function strataTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#5b4a3a");
  grad.addColorStop(0.08, "#4a3b2e");
  grad.addColorStop(0.35, "#3a3029");
  grad.addColorStop(0.36, "#2f2823");
  grad.addColorStop(0.7, "#262019");
  grad.addColorStop(1, "#15120f");
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
