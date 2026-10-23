import { rainRate } from "./sim/storm";
import type { StormSpec } from "./sim/types";

/**
 * A stand-in for the court's ultrasonic level sensor, used by the dashboard's Live and Replay modes
 * (on a phone there is no full simulation running). It is a lumped level-pool model: runoff from the
 * streets that drain to the square (rational method), minus the outlet pipe (orifice equation),
 * throttled while the tide is high — the same physics as the square in the 2-D model, without the town.
 */
export class SensorSim {
  t = 0;
  V = 0;
  peakV = 0;
  readonly area: number;
  readonly Vmax: number;
  readonly outletArea: number;
  clog = 0;
  storm: StormSpec | null = null;
  inflow = 0;
  outflow = 0;
  expectedOutflow = 0;
  emptyAt: number | null = null;
  private filled = false;

  constructor(
    readonly w = 40,
    readonly l = 30,
    readonly depth = 1,
    outletD = 0.2,
    /** street area whose gutters lead to the square, m² */
    readonly catchment = 9000,
    readonly runoffC = 0.85,
  ) {
    this.area = w * l;
    this.Vmax = this.area * depth;
    this.outletArea = (Math.PI * outletD * outletD) / 4;
  }

  start(storm: StormSpec) {
    this.storm = storm;
    this.t = 0;
    this.V = 0;
    this.peakV = 0;
    this.emptyAt = null;
    this.filled = false;
  }

  get level() {
    return this.V / this.area;
  }
  get fill() {
    return this.V / this.Vmax;
  }
  get rainMmH() {
    return this.storm ? rainRate(this.storm, this.t) * 3.6e6 : 0;
  }

  step(dt: number) {
    const s = this.storm;
    const D = s ? s.durationMin * 60 : 0;
    const r = s ? rainRate(s, this.t) : 0;
    // drains take the first part of the runoff; the rest reaches the square
    const drainCap = (30 / 3.6e6) * (s?.highTide && this.t < D + 3600 ? 0.35 : 1);
    const runoff = Math.max(0, r * this.runoffC - drainCap) * this.catchment + r * this.area;
    this.inflow = this.V < this.Vmax * 1.02 ? runoff : 0;
    const head = this.level;
    const qClear = 0.6 * this.outletArea * Math.sqrt(2 * 9.81 * Math.max(head, 0));
    const tideThrottle = s?.highTide && this.t < D + 3600 ? 0.25 : this.t < D ? 0.6 : 1;
    this.expectedOutflow = qClear * tideThrottle;
    this.outflow = qClear * tideThrottle * (1 - this.clog);
    this.V = Math.max(0, this.V + (this.inflow - this.outflow) * dt);
    this.peakV = Math.max(this.peakV, this.V);
    if (this.level > 0.05) this.filled = true;
    if (this.filled && this.emptyAt === null && this.t > D && this.level < 0.01) this.emptyAt = this.t;
    this.t += dt;
  }

  /** Seconds to empty from now with the outlet alone. */
  projectedEmpty(): number | null {
    const k = 0.6 * this.outletArea * Math.sqrt(2 * 9.81) * (1 - this.clog);
    if (k <= 0) return null;
    return (2 * this.area * Math.sqrt(Math.max(0, this.level - 0.01))) / k;
  }
}
