/**
 * Court alerts. One rule set serves both the simulation-linked gauge and the live (MET Malaysia +
 * simulated sensor) mode, so what judges see in the demo is exactly what residents would get.
 */
export type AlertKind = "closing" | "full80" | "open" | "clog" | "weather" | "info";
export type AlertLevel = "info" | "warn" | "danger" | "ok";

export interface CourtAlert {
  id: string;
  kind: AlertKind;
  level: AlertLevel;
  title: string;
  body: string;
  /** Simulated seconds since storm start (sim) or epoch ms (live). */
  at: number;
  clock: "sim" | "live";
}

export interface SensorSample {
  /** seconds (sim) or epoch ms (live) */
  at: number;
  /** water level above the court floor, m */
  level: number;
  /** stored volume / capacity */
  fill: number;
  rainMmH: number;
  /** heavy rain forecast or warning in force */
  heavyExpected: boolean;
  /** outlet flow measured, m³/s */
  outflow: number;
  /** outlet flow the pipe should carry at this level (clear pipe, drains not backed up), m³/s */
  expectedOutflow: number;
  /** seconds per unit of `at` (1 for sim seconds, 0.001 for epoch ms) */
  secondsPerUnit: number;
}

export const THRESHOLDS = {
  closeRainMmH: 10,
  wetLevel: 0.02,
  fullFill: 0.8,
  openLevel: 0.01,
  openQuietSeconds: 15 * 60,
  clogRatio: 0.5,
  clogSeconds: 10 * 60,
};

let seq = 0;
const mk = (a: Omit<CourtAlert, "id">): CourtAlert => ({ ...a, id: `${a.kind}-${a.at}-${seq++}` });

export class AlertEngine {
  closed = false;
  private fired80 = false;
  private quietSince: number | null = null;
  private clogSince: number | null = null;
  private clogFired = false;
  constructor(private clock: "sim" | "live") {}

  reset() {
    this.closed = false;
    this.fired80 = false;
    this.quietSince = null;
    this.clogSince = null;
    this.clogFired = false;
  }

  update(s: SensorSample): CourtAlert[] {
    const out: CourtAlert[] = [];
    const sec = (d: number) => d * s.secondsPerUnit;
    if (!this.closed) {
      const reason =
        s.level > THRESHOLDS.wetLevel
          ? `Water is entering the court (${(s.level * 100).toFixed(0)} cm).`
          : s.rainMmH >= THRESHOLDS.closeRainMmH
            ? `Heavy rain: ${s.rainMmH.toFixed(0)} mm/h falling now.`
            : s.heavyExpected
              ? "Heavy rain or thunderstorms are forecast for Klang."
              : null;
      if (reason) {
        this.closed = true;
        this.quietSince = null;
        out.push(
          mk({
            kind: "closing",
            level: "warn",
            title: "Court closing",
            body: `${reason} Please leave the court — it is about to fill with storm water.`,
            at: s.at,
            clock: this.clock,
          }),
        );
      }
    }
    if (this.closed && !this.fired80 && s.fill >= THRESHOLDS.fullFill) {
      this.fired80 = true;
      out.push(
        mk({
          kind: "full80",
          level: "danger",
          title: "Water square 80% full",
          body: `Holding ${(s.fill * 100).toFixed(0)}% of capacity. Keep clear of the edges; overflow goes to the street drains.`,
          at: s.at,
          clock: this.clock,
        }),
      );
    }
    if (s.fill < 0.5) this.fired80 = false;

    // Clog: after the rain, the level should fall as fast as the outlet pipe allows.
    const draining = s.rainMmH < 1 && s.level > 0.05 && s.expectedOutflow > 1e-4;
    if (draining && s.outflow < THRESHOLDS.clogRatio * s.expectedOutflow) {
      if (this.clogSince === null) this.clogSince = s.at;
      if (!this.clogFired && sec(s.at - this.clogSince) >= THRESHOLDS.clogSeconds) {
        this.clogFired = true;
        out.push(
          mk({
            kind: "clog",
            level: "danger",
            title: "Clog warning",
            body: `The square is draining at ${((s.outflow / s.expectedOutflow) * 100).toFixed(0)}% of the expected rate. Check the outlet grate for leaves and litter.`,
            at: s.at,
            clock: this.clock,
          }),
        );
      }
    } else {
      this.clogSince = null;
    }

    if (this.closed) {
      const quiet = s.level < THRESHOLDS.openLevel && s.rainMmH < 1 && !s.heavyExpected;
      if (quiet) {
        if (this.quietSince === null) this.quietSince = s.at;
        if (sec(s.at - this.quietSince) >= THRESHOLDS.openQuietSeconds) {
          this.closed = false;
          this.clogFired = false;
          out.push(
            mk({
              kind: "open",
              level: "ok",
              title: "Court open again",
              body: "The square has drained and dried. Games on.",
              at: s.at,
              clock: this.clock,
            }),
          );
        }
      } else this.quietSince = null;
    }
    return out;
  }
}
