"use client";
import { create } from "zustand";
import type { CourtAlert } from "./alerts";
import type { SceneData } from "./data/scene";
import { type Area, CASIRA } from "./geo";
import type { Shade, ViewMode } from "./render/scene3d";
import { KAPAR_2023 } from "./sim/storm";
import { DEFAULT_PARAMS, type Feature, type ModelParams, type Stats, type StormSpec } from "./sim/types";

export type Phase = "pick" | "design" | "monitor";
export type Tool = "select" | "square" | "garden" | "permeable" | "drain" | "inlet";
export type RunStatus = "idle" | "starting" | "running" | "paused" | "done";

/** A planner's handwritten note pinned to the 3D model. */
export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
  tone: "tomato" | "water";
  /** which run it describes: shown on that side of a split */
  side: "base" | "design";
}

export interface NearStats {
  peakDepth: number;
  buildingsWet: number;
  floodedRoadArea: number;
  buildings: number;
}

export interface History {
  t: number[];
  rain: number[];
  baseStreet: number[];
  designStreet: number[];
  baseBuildings: number[];
  designBuildings: number[];
  level: number[];
  fill: number[];
}

const emptyHistory = (): History => ({ t: [], rain: [], baseStreet: [], designStreet: [], baseBuildings: [], designBuildings: [], level: [], fill: [] });

export interface Snapshot {
  /** PNG data URLs */
  without?: string;
  with?: string;
  split?: string;
}

interface State {
  phase: Phase;
  area: Area;
  scene: SceneData | null;
  sceneStatus: "idle" | "loading" | "ready" | "error";
  loadLabel: string;
  loadProgress: number;
  sceneError: string | null;

  features: Feature[];
  selectedId: string | null;
  tool: Tool;
  drawing: [number, number][] | null;
  showCandidates: boolean;
  activeCandidate: number;

  storm: StormSpec;
  preset: "kapar" | "custom";
  params: ModelParams;

  run: { status: RunStatus; t: number; tEnd: number; speed: number; designDirty: boolean };
  stats: { base?: Stats; design?: Stats };
  finals: { base?: Stats; design?: Stats };
  history: History;
  view: ViewMode;
  shade: Shade;
  split: number;
  alerts: CourtAlert[];
  courtClosed: boolean;
  snapshot: Snapshot;
  toast: string | null;
  notes: Note[];
  /** results within 150 m of the design: worst moment of each run */
  near: { base?: NearStats; design?: NearStats; live?: { base?: NearStats; design?: NearStats } };
  solver: "gpu" | "cpu" | null;

  set: (p: Partial<State>) => void;
  setArea: (a: Area) => void;
  addFeature: (f: Feature) => void;
  updateFeature: (id: string, p: Partial<Feature>) => void;
  removeFeature: (id: string) => void;
  setStorm: (p: Partial<StormSpec>) => void;
  setParams: (p: Partial<ModelParams>) => void;
  pushHistory: (row: { t: number; rain: number; baseStreet?: number; designStreet?: number; baseBuildings?: number; designBuildings?: number; level?: number; fill?: number }) => void;
  resetRun: () => void;
  pushAlerts: (a: CourtAlert[]) => void;
  flash: (msg: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useApp = create<State>((set, get) => ({
  phase: "pick",
  area: CASIRA,
  scene: null,
  sceneStatus: "idle",
  loadLabel: "",
  loadProgress: 0,
  sceneError: null,

  features: [],
  selectedId: null,
  tool: "select",
  drawing: null,
  showCandidates: true,
  activeCandidate: 0,

  storm: { ...KAPAR_2023 },
  preset: "kapar",
  params: { ...DEFAULT_PARAMS },

  run: { status: "idle", t: 0, tEnd: 0, speed: 900, designDirty: false },
  stats: {},
  finals: {},
  history: emptyHistory(),
  view: "with",
  shade: "real",
  split: 0.5,
  alerts: [],
  courtClosed: false,
  snapshot: {},
  toast: null,
  notes: [],
  near: {},
  solver: null,

  set: (p) => set(p),
  setArea: (a) => set({ area: a }),
  addFeature: (f) => set({ features: [...get().features, f], selectedId: f.id, run: { ...get().run, designDirty: true } }),
  updateFeature: (id, p) =>
    set({ features: get().features.map((f) => (f.id === id ? ({ ...f, ...p } as Feature) : f)), run: { ...get().run, designDirty: true } }),
  removeFeature: (id) =>
    set({ features: get().features.filter((f) => f.id !== id), selectedId: get().selectedId === id ? null : get().selectedId, run: { ...get().run, designDirty: true } }),
  setStorm: (p) => set({ storm: { ...get().storm, ...p }, preset: "custom" }),
  setParams: (p) => set({ params: { ...get().params, ...p } }),
  pushHistory: (r) => {
    const h = get().history;
    const last = h.t[h.t.length - 1];
    if (last !== undefined && r.t - last < 30 && r.t < get().run.tEnd) return;
    set({
      history: {
        t: [...h.t, r.t],
        rain: [...h.rain, r.rain],
        baseStreet: [...h.baseStreet, r.baseStreet ?? NaN],
        designStreet: [...h.designStreet, r.designStreet ?? NaN],
        baseBuildings: [...h.baseBuildings, r.baseBuildings ?? NaN],
        designBuildings: [...h.designBuildings, r.designBuildings ?? NaN],
        level: [...h.level, r.level ?? NaN],
        fill: [...h.fill, r.fill ?? NaN],
      },
    });
  },
  resetRun: () =>
    set({ stats: {}, finals: {}, near: {}, notes: [], history: emptyHistory(), alerts: [], courtClosed: false, snapshot: {}, run:
 { ...get().run, status: "idle", t: 0, designDirty: false } }),
  pushAlerts: (a) => a.length && set({ alerts: [...a, ...get().alerts].slice(0, 40) }),
  flash: (msg) => {
    clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 3200);
  },
}));

export function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
