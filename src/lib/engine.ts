"use client";
import { AlertEngine } from "./alerts";
import { buildScene, placeCourt, type SceneData } from "./data/scene";
import type { Area } from "./geo";
import { Scene3D } from "./render/scene3d";
import { type RunFrame, SimController } from "./sim/controller";
import { ORIFICE_CD } from "./sim/model";
import { type FeatureStat, Land } from "./sim/types";
import { type NearStats, useApp } from "./store";

const NEAR_R = 150;
type FeatureStatHost = { features: FeatureStat[] };


import { MONITOR_CHANNEL, type MonitorMessage } from "./monitor-channel";

export { MONITOR_CHANNEL, type MonitorMessage };

/** Owns the renderer and the simulation for the page and keeps the store in step with them. */
class Engine {
  scene3d: Scene3D | null = null;
  sim = new SimController();
  alerts = new AlertEngine("sim");
  private bc: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(MONITOR_CHANNEL) : null;
  private rims: { off: Int32Array; cells: Int32Array } | null = null;
  /** cells and buildings within NEAR_R of the design, fixed at run start */
  private zone: { roads: Int32Array; buildings: Int32Array } | null = null;
  private wet: Float32Array = new Float32Array(0);
  private unsub: (() => void) | null = null;
  private loadToken = 0;
  /** worst-moment depths of the last run of the town as it is */
  basePeak: Float32Array | null = null;

  constructor() {
    this.sim.onFrame = (key, f) => this.frame(key, f);
    this.sim.onTick = (t, done) => this.tick(t, done);
    this.sim.onFinal = (key, f) => {
      useApp.setState((s) => ({ finals: { ...s.finals, [key]: f.stats } }));
      const solo = !this.sim.latest.base;
      const runKey = solo ? "base" : key;
      const ns = this.nearStats(f.peak);
      if (ns) useApp.setState((s) => ({ near: { ...s.near, [runKey]: ns } }));
      if (runKey === "base") {
        this.basePeak = f.peak;
        this.rateCandidates(f.peak);
      }
      this.pinNotes(runKey, f.peak, f.stats);
      if (this.sim.finals.design && (this.sim.finals.base || !this.sim.latest.base)) this.capturePeaks();
    };
    this.sim.onError = (m) => useApp.getState().flash(`Simulation error: ${m}`);
  }

  attach(container: HTMLElement) {
    if (this.scene3d) return;
    this.scene3d = new Scene3D(container);
    const s = useApp.getState();
    if (s.scene) {
      this.scene3d.setScene(s.scene);
      this.scene3d.setFeatures(s.features, s.selectedId);
      this.scene3d.showCandidates(s.showCandidates && s.run.status === "idle", s.activeCandidate);
    }
    this.scene3d.view = s.view;
    this.scene3d.shade = s.shade;
    this.scene3d.split = s.split;
    // keep the renderer in step with the store
    this.unsub = useApp.subscribe((st, prev) => {
      const r = this.scene3d;
      if (!r) return;
      if (st.features !== prev.features || st.selectedId !== prev.selectedId) r.setFeatures(st.features, st.selectedId);
      if (st.view !== prev.view) r.view = st.view;
      if (st.shade !== prev.shade) r.shade = st.shade;
      if (st.split !== prev.split) r.split = st.split;
      if (st.showCandidates !== prev.showCandidates || st.activeCandidate !== prev.activeCandidate || st.run.status !== prev.run.status)
        r.showCandidates(st.showCandidates, st.activeCandidate);
      if (st.params.clog !== prev.params.clog) this.sim.setClog(st.params.clog);
    });
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
    this.scene3d?.dispose();
    this.scene3d = null;
  }

  async loadArea(area: Area) {
    const token = ++this.loadToken;
    this.basePeak = null;
    this.sim.stop();
    const st = useApp.getState();
    st.resetRun();
    useApp.setState({ sceneStatus: "loading", loadLabel: "Fetching data", loadProgress: 0, sceneError: null, area, features: [], selectedId: null, phase: "design" });
    try {
      const scene = await buildScene(area, (label, f) => {
        if (token === this.loadToken) useApp.setState({ loadLabel: label, loadProgress: f });
      });
      if (token !== this.loadToken) return;
      this.prepareRims(scene);
      useApp.setState({ scene, sceneStatus: "ready", activeCandidate: 0, showCandidates: true });
      if (this.scene3d) {
        this.scene3d.setScene(scene);
        this.scene3d.setFeatures([], null);
        this.scene3d.showCandidates(true, 0);
      }
      for (const w of scene.warnings) useApp.getState().flash(w);
    } catch (err) {
      if (token !== this.loadToken) return;
      useApp.setState({ sceneStatus: "error", sceneError: (err as Error).message });
    }
  }

  private prepareRims(scene: SceneData) {
    const { nx, ny, buildingId, land } = scene.grid;
    const nB = scene.buildings.length;
    const lists: number[][] = Array.from({ length: nB }, () => []);
    for (let c = 0; c < nx * ny; c++) {
      if (land[c] === Land.Building) continue;
      const i = c % nx;
      const j = (c / nx) | 0;
      const seen = new Set<number>();
      for (const d of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1]) {
        if (d < 0) continue;
        const b = buildingId[d];
        if (b >= 0 && !seen.has(b)) {
          seen.add(b);
          lists[b].push(c);
        }
      }
    }
    const off = new Int32Array(nB + 1);
    for (let b = 0; b < nB; b++) off[b + 1] = off[b] + lists[b].length;
    const cells = new Int32Array(off[nB]);
    for (let b = 0; b < nB; b++) cells.set(lists[b], off[b]);
    this.rims = { off, cells };
    this.wet = new Float32Array(nB);
  }

  /** Handwritten notes on the model: where the street flooded deepest, and how full the court got. */
  private pinNotes(side: "base" | "design", peak: Float32Array, stats: FeatureStatHost) {
    const s = useApp.getState();
    const sc = s.scene;
    if (!sc) return;
    const { nx, dx, land } = sc.grid;
    const notes = s.notes.filter((n) => n.side !== side);
    let best = 0;
    let bc = -1;
    for (let c = 0; c < peak.length; c++)
      if (land[c] === Land.Road && peak[c] > best) {
        best = peak[c];
        bc = c;
      }
    if (side === "base" && bc >= 0 && best > 0.05) {
      notes.push({ id: `deep-${side}`, x: ((bc % nx) + 0.5) * dx, y: (((bc / nx) | 0) + 0.5) * dx, text: `worst street — ${Math.round(best * 100)} cm deep`, tone: "tomato", side });
    }
    if (side === "design") {
      const sq = stats.features.find((f) => f.kind === "square");
      const ft = sq && s.features.find((f) => f.id === sq.id);
      if (sq && ft && ft.kind === "square") {
        notes.push({
          id: `court-${side}`,
          x: ft.cx,
          y: ft.cy,
          text: `court held ${Math.round(sq.peakStored).toLocaleString()} m³ — ${Math.round((sq.peakStored / Math.max(1, sq.capacity)) * 100)}% full`,
          tone: "water",
          side,
        });
      }
    }
    // once both runs are in (either may finish first): how much shallower the streets near the court got
    const nb = useApp.getState().near.base;
    const nd = useApp.getState().near.design;
    const kept = notes.filter((n) => n.id !== "near");
    const deep = kept.find((n) => n.id === "deep-base");
    if (nb && nd && nb.peakDepth > 0 && deep) {
      const drop = Math.round((1 - nd.peakDepth / nb.peakDepth) * 100);
      if (drop > 2) kept.push({ id: "near", x: deep.x + 6, y: deep.y + 4, text: `${drop}% shallower with the court`, tone: "water", side: "design" });
    }
    useApp.setState({ notes: kept });

  }

  /** Road cells and buildings within `r` metres of any design feature. */
  private makeZone(r = NEAR_R) {
    const s = useApp.getState();
    const sc = s.scene;
    if (!sc || !s.features.length) return null;
    const pts: [number, number][] = [];
    for (const f of s.features) {
      if (f.kind === "drain") pts.push(...f.pts);
      else if (f.kind === "inlet") pts.push([f.x, f.y]);
      else pts.push([f.cx, f.cy]);
    }
    const { nx, ny, dx, land } = sc.grid;
    const near = (x: number, y: number) => pts.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < r * r);
    const roads: number[] = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (land[c] === Land.Road && near((i + 0.5) * dx, (j + 0.5) * dx)) roads.push(c);
      }
    const bl: number[] = [];
    sc.buildings.forEach((b, k) => {
      let x = 0,
        y = 0;
      for (const p of b.ring) {
        x += p[0];
        y += p[1];
      }
      if (near(x / b.ring.length, y / b.ring.length)) bl.push(k);
    });
    return { roads: Int32Array.from(roads), buildings: Int32Array.from(bl) };
  }

  nearStats(depth: Float32Array): NearStats | undefined {
    const z = this.zone;
    const r = this.rims;
    const sc = useApp.getState().scene;
    if (!z || !r || !sc) return undefined;
    const thr = useApp.getState().params.buildingThreshold;
    const A = sc.grid.dx * sc.grid.dx;
    let peak = 0;
    let area = 0;
    for (const c of z.roads) {
      const d = depth[c];
      if (d > peak) peak = d;
      if (d > 0.15) area += A;
    }
    let wet = 0;
    for (const b of z.buildings) {
      let m = 0;
      for (let k = r.off[b]; k < r.off[b + 1]; k++) m = Math.max(m, depth[r.cells[k]]);
      if (m > thr) wet++;
    }
    return { peakDepth: peak, buildingsWet: wet, floodedRoadArea: area, buildings: z.buildings.length };
  }

  /** After a run of the town as it is: how bad is it around each candidate site? */
  private rateCandidates(peak: Float32Array) {
    const s = useApp.getState();
    const sc = s.scene;
    const r = this.rims;
    if (!sc || !r) return;
    const thr = s.params.buildingThreshold;
    const { nx, dx, land } = sc.grid;
    const cent = sc.buildings.map((b) => {
      let x = 0,
        y = 0;
      for (const p of b.ring) {
        x += p[0];
        y += p[1];
      }
      return [x / b.ring.length, y / b.ring.length];
    });
    const wetB = sc.buildings.map((_, b) => {
      let m = 0;
      for (let k = r.off[b]; k < r.off[b + 1]; k++) m = Math.max(m, peak[r.cells[k]]);
      return m > thr;
    });
    for (const cd of sc.candidates) {
      let n = 0;
      cent.forEach(([x, y], b) => {
        if (wetB[b] && Math.hypot(x - cd.bx, y - cd.by) < NEAR_R) n++;
      });
      let deep = 0;
      const R = Math.ceil(NEAR_R / dx);
      const ci = Math.floor(cd.bx / dx);
      const cj = Math.floor(cd.by / dx);
      for (let j = Math.max(0, cj - R); j <= Math.min(sc.grid.ny - 1, cj + R); j++)
        for (let i = Math.max(0, ci - R); i <= Math.min(nx - 1, ci + R); i++) {
          const c = j * nx + i;
          if (land[c] === Land.Road && (i - ci) ** 2 + (j - cj) ** 2 <= R * R) deep = Math.max(deep, peak[c]);
        }
      cd.floodedNear = n;
      cd.deepestNear = deep;
      // move the suggested court to where the water pooled at the worst moment
      const k = sc.candidates.indexOf(cd);
      const p = placeCourt(cd, k, sc.grid, sc.candidateMask, (c) => peak[c]);
      if (p) {
        cd.bx = p.x;
        cd.by = p.y;
        cd.courtW = p.w;
        cd.courtL = p.l;
      }
    }
    // point the designer at the site that helps most: it fits, and has the most flooded homes around it
    let best = s.activeCandidate;
    let bs = -1;
    sc.candidates.forEach((cd, k) => {
      const v = (cd.fits ? 1000 : 0) + (cd.floodedNear ?? 0) * 10 + cd.score / 10;
      if (v > bs) {
        bs = v;
        best = k;
      }
    });
    useApp.setState({ scene: { ...sc }, activeCandidate: s.features.length ? s.activeCandidate : best });
  }

  private buildingWet(depth: Float32Array): Float32Array {
    const thr = useApp.getState().params.buildingThreshold;
    const r = this.rims;
    if (!r) return this.wet;
    const out = new Float32Array(this.wet.length);
    for (let b = 0; b < out.length; b++) {
      let m = 0;
      for (let k = r.off[b]; k < r.off[b + 1]; k++) m = Math.max(m, depth[r.cells[k]]);
      out[b] = Math.max(0, Math.min(1, (m - thr * 0.6) / (thr * 0.4)));
    }
    return out;
  }

  async startRun() {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    const s = useApp.getState();
    if (!s.scene) return;
    s.resetRun();
    this.alerts.reset();
    this.zone = this.makeZone();
    useApp.setState({ run: { ...useApp.getState().run, status: "starting", t: 0 }, showCandidates: false, view: s.features.length ? s.view : "without" });
    this.sim.speed = s.run.speed;
    try {
      await this.sim.start(s.scene.grid, s.features, s.storm, s.params, s.features.length > 0, !new URLSearchParams(location.search).has("cpu"));
      useApp.setState({ run: { ...useApp.getState().run, status: "running", tEnd: this.sim.tEnd }, solver: this.sim.engine });
    } catch (err) {
      useApp.setState({ run: { ...useApp.getState().run, status: "idle" } });
      useApp.getState().flash(`Could not start: ${(err as Error).message}`);
    }
  }

  setSpeed(speed: number) {
    this.sim.speed = speed;
    useApp.setState((s) => ({ run: { ...s.run, speed } }));
  }
  pause() {
    this.sim.pause();
    useApp.setState((s) => ({ run: { ...s.run, status: "paused" } }));
  }
  resume() {
    this.sim.resume();
    useApp.setState((s) => ({ run: { ...s.run, status: "running" } }));
  }
  stop() {
    this.sim.stop();
    useApp.getState().resetRun();
    this.scene3d?.setWater("base", null);
    this.scene3d?.setWater("design", null);
    this.scene3d?.setRain(0);
    if (this.rims) {
      this.scene3d?.setBuildingWet("base", new Float32Array(this.wet.length));
      this.scene3d?.setBuildingWet("design", new Float32Array(this.wet.length));
    }
  }

  /** Director mode: water frames kept during a run so any moment can be shown again exactly. */
  recording: Partial<Record<"base" | "design", { t: number[]; depth: Float32Array[]; speed: Float32Array[]; rain: number[] }>> | null = null;
  recordEvery = 60;

  private record(key: "base" | "design", f: RunFrame) {
    const rec = (this.recording![key] ??= { t: [], depth: [], speed: [], rain: [] });
    const last = rec.t[rec.t.length - 1];
    if (last !== undefined && f.t - last < this.recordEvery && !f.done) return;
    if (last !== undefined && f.t <= last) return;
    rec.t.push(f.t);
    rec.depth.push(f.depth.slice());
    rec.speed.push(f.speed.slice());
    rec.rain.push(f.stats.rainRateMmH);
  }

  /** Director mode: show both runs as they were at storm time `t` (seconds), interpolating between recorded frames. */
  showAt(t: number) {
    const r = this.scene3d;
    if (!r || !this.recording) return;
    for (const key of ["base", "design"] as const) {
      const rec = this.recording[key];
      if (!rec?.t.length) continue;
      let k = 0;
      while (k + 1 < rec.t.length && rec.t[k + 1] <= t) k++;
      const k2 = Math.min(rec.t.length - 1, k + 1);
      const a = k2 === k ? 0 : Math.max(0, Math.min(1, (t - rec.t[k]) / (rec.t[k2] - rec.t[k])));
      const mix = (u: Float32Array, v: Float32Array) => {
        const out = new Float32Array(u.length);
        for (let c = 0; c < u.length; c++) out[c] = u[c] + (v[c] - u[c]) * a;
        return out;
      };
      const depth = mix(rec.depth[k], rec.depth[k2]);
      r.setWater(key, depth, mix(rec.speed[k], rec.speed[k2]));
      r.setBuildingWet(key, this.buildingWet(depth));
      r.setRain(rec.rain[k] + (rec.rain[k2] - rec.rain[k]) * a);
    }
  }

  private frame(key: "base" | "design", f: RunFrame) {
    if (this.recording) this.record(key, f);
    const r = this.scene3d;
    // With no design, the "without" run is the only one: show it on both sides.
    const single = !this.sim.latest.base && key === "design" && useApp.getState().features.length === 0;
    if (r) {
      const wet = this.buildingWet(f.depth);
      r.setWater(key, f.depth, f.speed);
      r.setBuildingWet(key, wet);
      if (single) {
        r.setWater("base", f.depth, f.speed);
        r.setBuildingWet("base", wet);
      }
      r.setRain(f.stats.rainRateMmH);
    }
    useApp.setState((s) => ({ stats: { ...s.stats, [key]: f.stats } }));
    if (this.zone) {
      const ns = this.nearStats(f.depth);
      if (ns) useApp.setState((s) => ({ near: { ...s.near, live: { ...s.near.live, [key]: ns } } }));
    }
  }

  private tick(t: number, done: boolean) {
    const s = useApp.getState();
    // With no design only one run exists; it is the "without" case.
    const solo = !this.sim.latest.base;
    const base = solo ? this.sim.latest.design?.stats : this.sim.latest.base?.stats;
    const design = solo ? undefined : this.sim.latest.design?.stats;
    const sq = design?.features.find((f) => f.kind === "square");
    s.pushHistory({
      t,
      rain: (base ?? design)?.rainRateMmH ?? 0,
      baseStreet: base?.streetDepth,
      designStreet: design?.streetDepth,
      baseBuildings: base?.buildingsWet,
      designBuildings: design?.buildingsWet,
      level: sq?.level,
      fill: sq?.fill,
    });
    useApp.setState((st) => ({ run: { ...st.run, t, status: done ? "done" : st.run.status === "paused" ? "paused" : "running" } }));
    if (sq) {
      const fresh = this.alerts.update({
        at: t,
        level: sq.level ?? 0,
        fill: sq.fill ?? 0,
        rainMmH: design!.rainRateMmH,
        heavyExpected: false,
        outflow: sq.outflow ?? 0,
        expectedOutflow: sq.expectedOutflow ?? 0,
        secondsPerUnit: 1,
      });
      if (fresh.length) s.pushAlerts(fresh);
      useApp.setState({ courtClosed: this.alerts.closed });
      const h = useApp.getState().history;
      const msg: MonitorMessage = {
        type: "linked",
        t,
        tEnd: this.sim.tEnd,
        level: sq.level ?? 0,
        depth: (s.features.find((f) => f.id === sq.id) as { depth?: number } | undefined)?.depth ?? 1,
        fill: sq.fill ?? 0,
        capacity: sq.capacity,
        stored: sq.stored,
        rainMmH: design!.rainRateMmH,
        outflow: sq.outflow ?? 0,
        expectedOutflow: sq.expectedOutflow ?? 0,
        inflow: sq.inflow ?? 0,
        emptyAt: sq.emptyAt ?? null,
        projectedEmpty: sq.projectedEmpty ?? null,
        name: sq.name,
        running: !done,
        history: { t: h.t, level: h.level, rain: h.rain },
      };
      this.bc?.postMessage({ msg, alerts: useApp.getState().alerts, closed: this.alerts.closed });
      if (done && (sq.level ?? 0) > 0.01) this.drainDown(t, sq, msg);
    }
  }

  /**
   * The 2-D run stops two hours after the rain; the court may still hold water. Fast-forward its
   * emptying with the outlet alone (the same orifice equation, drains no longer backed up) so the
   * dashboard can show the whole cycle through to "Court open again".
   */
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private drainDown(t0: number, sq: FeatureStat, last: MonitorMessage) {
    if (this.drainTimer) clearInterval(this.drainTimer);
    const s = useApp.getState();
    const f = s.features.find((x) => x.id === sq.id);
    if (!f || f.kind !== "square") return;
    const area = sq.capacity / f.depth;
    const Ao = (Math.PI * (f.outletD ?? 0.2) ** 2) / 4;
    let V = sq.stored;
    let t = t0;
    const hist = { t: [...last.history.t], level: [...last.history.level], rain: [...last.history.rain] };
    this.drainTimer = setInterval(() => {
      const clog = useApp.getState().params.clog;
      let q = 0;
      let qe = 0;
      // 2 simulated minutes per 60 ms tick: ~15 s for a full court, time enough to try the clog switch
      for (let k = 0; k < 12; k++) {
        const qc = ORIFICE_CD * Ao * Math.sqrt(2 * 9.81 * Math.max(V / area, 0));
        qe = qc;
        q = qc * (1 - clog);
        V = Math.max(0, V - q * 10);
        t += 10;
      }
      const level = V / area;
      hist.t.push(t);
      hist.level.push(level);
      hist.rain.push(0);
      const fresh = this.alerts.update({ at: t, level, fill: V / (area * f.depth), rainMmH: 0, heavyExpected: false, outflow: q, expectedOutflow: qe, secondsPerUnit: 1 });
      if (fresh.length) useApp.getState().pushAlerts(fresh);
      useApp.setState({ courtClosed: this.alerts.closed });
      const k = ORIFICE_CD * Ao * Math.sqrt(2 * 9.81) * (1 - clog);
      const msg: MonitorMessage = {
        ...last,
        t,
        tEnd: Math.max(t, last.tEnd),
        level,
        fill: V / (area * f.depth),
        stored: V,
        rainMmH: 0,
        inflow: 0,
        outflow: q,
        expectedOutflow: qe,
        emptyAt: level < 0.01 ? t : null,
        projectedEmpty: k > 0 ? (2 * area * Math.sqrt(Math.max(0, level - 0.01))) / k : null,
        running: true,
        history: hist,
        drainDown: true,
      };
      this.bc?.postMessage({ msg, alerts: useApp.getState().alerts, closed: this.alerts.closed });
      if (!this.alerts.closed || t - t0 > 48 * 3600) {
        clearInterval(this.drainTimer!);
        this.drainTimer = null;
        this.bc?.postMessage({ msg: { ...msg, running: false }, alerts: useApp.getState().alerts, closed: this.alerts.closed });
      }
    }, 60);
  }

  /** After a run: render the peak flood of both scenarios for the export pack. */
  private capturePeaks() {
    const r = this.scene3d;
    const pb = this.sim.finals.base?.peak;
    const pd = this.sim.finals.design?.peak;
    if (!r || !pd) return;
    const lastB = this.sim.latest.base;
    const lastD = this.sim.latest.design;
    r.setRain(0);
    if (pb) r.setWater("base", pb);
    r.setWater("design", pd);
    if (pb) r.setBuildingWet("base", this.buildingWet(pb));
    r.setBuildingWet("design", this.buildingWet(pd));
    const snap = {
      without: pb ? r.capture("without") : undefined,
      with: r.capture("with"),
      split: pb ? r.capture("split") : undefined,
    };
    useApp.setState({ snapshot: snap });
    if (lastB) r.setWater("base", lastB.depth, lastB.speed);
    if (lastD) r.setWater("design", lastD.depth, lastD.speed);
  }

  /** Show the peak (worst moment) of the finished runs. */
  showPeaks(on: boolean) {
    const r = this.scene3d;
    if (!r) return;
    const pb = this.sim.finals.base?.peak;
    const pd = this.sim.finals.design?.peak;
    if (on) {
      if (pb) {
        r.setWater("base", pb);
        r.setBuildingWet("base", this.buildingWet(pb));
      }
      if (pd) {
        r.setWater("design", pd);
        r.setBuildingWet("design", this.buildingWet(pd));
        if (!pb) r.setWater("base", pd);
      }
    } else {
      const lb = this.sim.latest.base;
      const ld = this.sim.latest.design;
      if (lb) r.setWater("base", lb.depth, lb.speed);
      if (ld) r.setWater("design", ld.depth, ld.speed);
    }
  }
}

let engine: Engine | null = null;
export function getEngine(): Engine {
  if (!engine) engine = new Engine();
  return engine;
}
