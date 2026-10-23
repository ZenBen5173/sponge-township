/** BroadcastChannel contract between the simulator and the monitor dashboard (other tabs on this device). */
export const MONITOR_CHANNEL = "sponge-monitor";

export interface MonitorMessage {
  type: "linked";
  t: number;
  tEnd: number;
  level: number;
  depth: number;
  fill: number;
  capacity: number;
  stored: number;
  rainMmH: number;
  outflow: number;
  expectedOutflow: number;
  inflow: number;
  emptyAt: number | null;
  projectedEmpty: number | null;
  name: string;
  running: boolean;
  history: { t: number[]; level: number[]; rain: number[] };
  /** true while the court's emptying is being fast-forwarded after the 2-D run */
  drainDown?: boolean;
}

