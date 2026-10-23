/// <reference lib="webworker" />
import { GpuSolver } from "./gpu";
import { FloodModel } from "./model";
import type { Feature, GridData, ModelParams, Stats, StormSpec } from "./types";

export type ToWorker =
  | { type: "init"; grid: GridData; features: Feature[]; storm: StormSpec; params: ModelParams; gpu: boolean }
  | { type: "advance"; to: number; budgetMs: number; seq: number }
  | { type: "setClog"; clog: number };

export type FromWorker =
  | { type: "ready"; tEnd: number; squares: { id: string; floor: number; depth: number; cells: number }[]; engine: "gpu" | "cpu" }
  | { type: "frame"; t: number; depth: Float32Array; speed: Float32Array; stats: Stats; done: boolean; seq: number }
  | { type: "final"; peak: Float32Array; stats: Stats }
  | { type: "error"; message: string };

let model: FloodModel | null = null;
let gpu: GpuSolver | null = null;
let lastStatsT = 0;
let finalSent = false;

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

// Messages are handled strictly one after another (the GPU path awaits).
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<ToWorker>) => {
  queue = queue.then(() => handle(ev.data));
};

async function handle(msg: ToWorker) {
  try {
    if (msg.type === "init") {
      gpu?.destroy();
      gpu = null;
      model = new FloodModel(msg.grid, msg.features, msg.storm, msg.params);
      if (msg.gpu) {
        try {
          gpu = await GpuSolver.create(model);
        } catch (err) {
          console.warn("WebGPU init failed, using the CPU solver", err);
          gpu = null;
        }
      }
      lastStatsT = 0;
      finalSent = false;
      post({ type: "ready", tEnd: model.tEnd, squares: model.squareFloors(), engine: gpu ? "gpu" : "cpu" });
      sendFrame(0, -1);
    } else if (msg.type === "setClog" && model) {
      (model.params as ModelParams).clog = msg.clog;
    } else if (msg.type === "advance" && model) {
      const t0 = performance.now();
      let n = 0;
      if (gpu && gpu.ok) n = await gpu.advanceTo(msg.to, msg.budgetMs);
      else n = model.advanceTo(msg.to, msg.budgetMs);
      const ms = performance.now() - t0;
      sendFrame(ms > 0 ? (n / ms) * 1000 : 0, msg.seq);
    }
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
}

function sendFrame(stepsPerSec: number, seq: number) {
  if (!model) return;
  const depth = new Float32Array(model.N);
  const speed = new Float32Array(model.N);
  model.depthField(depth);
  model.speedField(speed);
  const stats = model.stats(model.t - lastStatsT, stepsPerSec);
  lastStatsT = model.t;
  const done = model.done;
  post({ type: "frame", t: model.t, depth, speed, stats, done, seq }, [depth.buffer, speed.buffer]);
  if (done && !finalSent) {
    finalSent = true;
    const peak = Float32Array.from(model.hPeak);
    // squares: report their peak level on the footprint
    for (const sq of model.squares) for (const c of sq.cells) peak[c] = sq.peakV / sq.area;
    post({ type: "final", peak, stats }, [peak.buffer]);
  }
}
