"use client";
import type { Feature, GridData, ModelParams, Stats, StormSpec } from "./types";
import type { FromWorker, ToWorker } from "./worker";

export type RunKey = "base" | "design";
export interface RunFrame {
  t: number;
  depth: Float32Array;
  speed: Float32Array;
  stats: Stats;
  done: boolean;
}
export interface RunFinal {
  peak: Float32Array;
  stats: Stats;
}

/**
 * Runs the "without" and "with design" simulations in two Web Workers on the same storm, in lock-step:
 * the clock only moves on once both have reached the last target time, so the two are always compared
 * at the same moment of the storm.
 */
export class SimController {
  private workers: Partial<Record<RunKey, Worker>> = {};
  private pending = new Set<RunKey>();
  private raf = 0;
  private lastSend = 0;
  private reached = 0;
  private keys: RunKey[] = [];
  private seq = 0;
  latest: Partial<Record<RunKey, RunFrame>> = {};
  finals: Partial<Record<RunKey, RunFinal>> = {};
  squares: Partial<Record<RunKey, { id: string; floor: number; depth: number; cells: number }[]>> = {};
  tEnd = 0;
  engine: "gpu" | "cpu" = "cpu";
  /** Simulated seconds per real second; Infinity = as fast as possible. */
  speed = 600;
  playing = false;
  onFrame?: (key: RunKey, f: RunFrame) => void;
  onFinal?: (key: RunKey, f: RunFinal) => void;
  onTick?: (t: number, done: boolean) => void;
  onError?: (msg: string) => void;

  async start(grid: GridData, designFeatures: Feature[], storm: StormSpec, params: ModelParams, runBase = true, useGpu = true): Promise<void> {
    this.stop();
    this.latest = {};
    this.finals = {};
    this.reached = 0;
    this.keys = runBase ? ["base", "design"] : ["design"];
    const ready = this.keys.map(
      (key) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
          this.workers[key] = w;
          w.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(key, ev.data, resolve);
          w.onerror = (e) => {
            this.onError?.(e.message || "Simulation worker failed");
            reject(e);
          };
          const msg: ToWorker = { type: "init", grid, features: key === "base" ? [] : designFeatures, storm, params, gpu: useGpu };
          w.postMessage(msg);
        }),
    );
    await Promise.all(ready);
    this.playing = true;
    this.lastSend = performance.now();
    this.loop();
  }

  private handle(key: RunKey, msg: FromWorker, resolve?: () => void) {
    if (msg.type === "ready") {
      this.tEnd = msg.tEnd;
      this.engine = msg.engine;
      this.squares[key] = msg.squares;
      resolve?.();
    } else if (msg.type === "frame") {
      this.latest[key] = msg;
      if (msg.seq !== this.seq) {
        // the initial frame, or a reply to an older request: show it but keep waiting
        this.onFrame?.(key, msg);
        return;
      }
      this.pending.delete(key);
      this.onFrame?.(key, msg);
      if (this.pending.size === 0) {
        this.reached = Math.min(...this.keys.map((k) => this.latest[k]?.t ?? 0));
        const done = this.keys.every((k) => this.latest[k]?.done);
        this.onTick?.(this.reached, done);
        if (done) this.playing = false;
      }
    } else if (msg.type === "final") {
      this.finals[key] = msg;
      this.onFinal?.(key, msg);
    } else if (msg.type === "error") {
      this.onError?.(msg.message);
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.playing || this.pending.size > 0) return;
    const now = performance.now();
    const wall = Math.min(0.25, (now - this.lastSend) / 1000);
    this.lastSend = now;
    const step = Number.isFinite(this.speed) ? this.speed * wall : 3600;
    const to = Math.min(this.tEnd, this.reached + Math.max(step, 1));
    const budgetMs = Number.isFinite(this.speed) ? 90 : 140;
    this.seq++;
    for (const k of this.keys) {
      if (this.latest[k]?.done) continue;
      this.pending.add(k);
      this.workers[k]!.postMessage({ type: "advance", to, budgetMs, seq: this.seq } satisfies ToWorker);
    }
  };

  pause() {
    this.playing = false;
  }
  resume() {
    if (this.keys.some((k) => !this.latest[k]?.done)) {
      this.playing = true;
      this.lastSend = performance.now();
    }
  }
  setClog(clog: number) {
    this.workers.design?.postMessage({ type: "setClog", clog } satisfies ToWorker);
  }
  get running() {
    return this.keys.length > 0 && this.keys.some((k) => !this.latest[k]?.done);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    for (const w of Object.values(this.workers)) w?.terminate();
    this.workers = {};
    this.pending.clear();
    this.playing = false;
    this.keys = [];
  }
}
