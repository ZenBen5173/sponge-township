/**
 * Shared types for the flood model. Everything here is plain data so it can cross the
 * Web Worker boundary (structured clone) and be reused by the Node tests.
 */

/** Land class of one grid cell. Order matters: it is stored in a Uint8Array. */
export const Land = {
  Open: 0, // yards, verges, unmapped urban ground (compacted soil)
  Road: 1, // asphalt, kerbed, has a roadside drain
  Building: 2, // solid block, water cannot enter
  Green: 3, // grass, parks, playing fields
  Water: 4, // ponds, retention ponds
  Channel: 5, // open monsoon drain (concrete)
  Paved: 6, // car parks, hard courts
} as const;
export type Land = (typeof Land)[keyof typeof Land];

export type FeatureKind = "square" | "garden" | "permeable" | "drain" | "inlet";

/** A design feature in local metres. x east, y south (same orientation as grid rows). */
export interface FeatureBase {
  id: string;
  kind: FeatureKind;
  name: string;
}

export interface RectFeature extends FeatureBase {
  kind: "square" | "garden" | "permeable";
  cx: number;
  cy: number;
  w: number; // along local x before rotation
  l: number; // along local y before rotation
  rot: number; // radians
  /** Water square: sunken depth (m). Rain garden: ponding depth (m). */
  depth: number;
  /** Water square only: outlet pipe diameter (m). */
  outletD?: number;
}

export interface LineFeature extends FeatureBase {
  kind: "drain";
  pts: [number, number][];
  /** Capture capacity per metre of drain, m³/s per m. */
  capacityPerM: number;
}

export interface PointFeature extends FeatureBase {
  kind: "inlet";
  x: number;
  y: number;
  /** Capture capacity, m³/s. */
  capacity: number;
}

export type Feature = RectFeature | LineFeature | PointFeature;

export interface StormSpec {
  /** Total depth, mm. */
  totalMm: number;
  /** Duration, minutes. */
  durationMin: number;
  shape: "thunderstorm" | "uniform";
  highTide: boolean;
}

export interface ModelParams {
  /** Existing drain network capacity, expressed as mm/h over the whole area. */
  drainMmPerHour: number;
  /** Fraction of network capacity left at high tide (outfalls back up). */
  tideFactor: number;
  /** Water depth at the building edge that counts as "flooded" (m). */
  buildingThreshold: number;
  /** Simulated time after rain stops (minutes). */
  afterMin: number;
  /** Water square outlet blockage, 0 = clear, 1 = fully blocked. */
  clog: number;
}

export const DEFAULT_PARAMS: ModelParams = {
  drainMmPerHour: 30,
  tideFactor: 0.35,
  buildingThreshold: 0.15,
  afterMin: 120,
  clog: 0,
};

/** Static terrain and land data for one area, already on the simulation grid. */
export interface GridData {
  nx: number;
  ny: number;
  dx: number;
  /** Ground elevation (m above datum `z0`), row-major, j = 0 is the north row. */
  z: Float32Array;
  z0: number;
  land: Uint8Array;
  /** Building index per cell (-1 = none). */
  buildingId: Int32Array;
  nBuildings: number;
  /** Initial water depth (ponds). */
  h0: Float32Array;
}

/** Per-feature live readout. */
export interface FeatureStat {
  id: string;
  kind: FeatureKind;
  name: string;
  /** Water held right now, m³ (surface + underground storage). */
  stored: number;
  /** Most water held at any time, m³. */
  peakStored: number;
  /** Design capacity, m³ (where it has one). */
  capacity: number;
  /** Water square: level above floor, m. */
  level?: number;
  /** Water square: fraction full 0..1+. */
  fill?: number;
  /** Water square: outlet discharge now, m³/s. */
  outflow?: number;
  /** Water square: what a clear outlet would carry now, m³/s. */
  expectedOutflow?: number;
  /** Water square: inflow now, m³/s. */
  inflow?: number;
  /** Water captured to date (drains, inlets), m³. */
  captured?: number;
  /** Water square: sim time it emptied after the storm, s (null = not yet). */
  emptyAt?: number | null;
  /** Water square: projected time to empty from now with the outlet alone, s. */
  projectedEmpty?: number | null;
}

export interface Balance {
  rain: number;
  initial: number;
  surface: number;
  featureStore: number;
  infiltrated: number;
  drained: number;
  leftArea: number;
  /** (in − accounted) / in. */
  error: number;
}

export interface Stats {
  t: number;
  rainRateMmH: number;
  raining: boolean;
  /** Deepest water on any road cell right now / ever (m). */
  streetDepth: number;
  peakStreetDepth: number;
  /** 95th percentile of wet road depth now, m. */
  streetP95: number;
  /** Road area under more than 0.15 m now / ever, m². */
  floodedRoadArea: number;
  peakFloodedRoadArea: number;
  buildingsWet: number;
  peakBuildingsWet: number;
  features: FeatureStat[];
  balance: Balance;
  dt: number;
  stepsPerSec: number;
}
