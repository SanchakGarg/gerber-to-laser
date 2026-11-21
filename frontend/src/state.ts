import type { AppConfig, BoardView, ExportOptions, HoleRef, Side, XcsOpts, XcsResult } from "./api";

export interface State {
  config: AppConfig | null;
  board: BoardView | null;
  visible: Record<string, boolean>;
  busy: string | null;
  error: string | null;
  /** Options of the SVG/PNG zip ("More formats"). */
  exportOpts: ExportOptions;
  view: "2d" | "3d";
  side2d: "top" | "bottom";
  pickMode: boolean;
  mounting: HoleRef[];
  /** Label picked holes with their size and the distances between them on the 2D view. */
  showDims: boolean;
  xcsOpts: XcsOpts;
  xcs: XcsResult | null;
  xcsPending: boolean;
  xcsError: string | null;
  downloaded: boolean;
}

type Listener = (s: State, changed: Set<keyof State>) => void;

const listeners: Listener[] = [];

// Offsets, hole tolerance and hidden layers are machine calibration: remember them per browser.
const XCS_KEY = "g2l.xcs.v1";

const XCS_DEFAULTS: XcsOpts = {
  hidden: { front: [], back: [] },
  offsets: { cut: [0, 0], etch: [0, 0] },
  hole_tolerance: 0.2,
  invert_copper: false,
};

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const pair = (v: unknown): [number, number] =>
  Array.isArray(v) ? [num(v[0], 0), num(v[1], 0)] : [0, 0];
const keys = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);

function loadXcsOpts(): XcsOpts | null {
  try {
    const raw = localStorage.getItem(XCS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return {
      hidden: { front: keys(o?.hidden?.front), back: keys(o?.hidden?.back) },
      offsets: { cut: pair(o?.offsets?.cut), etch: pair(o?.offsets?.etch) },
      hole_tolerance: num(o?.hole_tolerance, XCS_DEFAULTS.hole_tolerance),
      invert_copper: !!o?.invert_copper,
    };
  } catch {
    return null;
  }
}

function saveXcsOpts(o: XcsOpts) {
  try {
    localStorage.setItem(XCS_KEY, JSON.stringify(o));
  } catch {
    /* private mode / storage blocked: settings just aren't remembered */
  }
}

// Whether hole dimensions are drawn on the board: a per-browser preference.
const DIMS_KEY = "g2l.dims.v1";

function loadShowDims() {
  try {
    return localStorage.getItem(DIMS_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveShowDims(on: boolean) {
  try {
    localStorage.setItem(DIMS_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the preference just isn't remembered */
  }
}

const stored = loadXcsOpts();
/** False until the user has changed an XCS setting in this browser (then server defaults don't override). */
export const hasStoredXcs = stored !== null;

export const state: State = {
  config: null,
  board: null,
  visible: {},
  busy: null,
  error: null,
  exportOpts: {
    sides: ["front", "back"],
    kinds: { copper: true, silk: true, mask: true, cut: true, drill: true },
    mirror_front: false,
    mirror_back: true,
    invert_copper: false,
    png: false,
    dpi: 1000,
    hole_tolerance: 0.2,
  },
  view: "2d",
  side2d: "top",
  pickMode: false,
  mounting: [],
  showDims: loadShowDims(),
  xcsOpts: stored ?? structuredClone(XCS_DEFAULTS),
  xcs: null,
  xcsPending: false,
  xcsError: null,
  downloaded: false,
};

export function subscribe(fn: Listener) {
  listeners.push(fn);
}

export function update(patch: Partial<State>) {
  const changed = new Set(Object.keys(patch) as (keyof State)[]);
  Object.assign(state, patch);
  if (changed.has("xcsOpts")) saveXcsOpts(state.xcsOpts);
  if (changed.has("showDims")) saveShowDims(state.showDims);
  listeners.forEach((fn) => fn(state, changed));
}

export function setXcsOpts(patch: Partial<XcsOpts>) {
  update({ xcsOpts: { ...state.xcsOpts, ...patch } });
}

export function isHidden(side: Side, key: string) {
  return state.xcsOpts.hidden[side].includes(key);
}

// Layers hidden by default: fab/courtyard/etc. and paste (not part of the laser job).
export function defaultVisible(role: string) {
  return !["other", "top_paste", "bottom_paste", "inner_copper"].includes(role);
}

export function isVisible(id: string) {
  return state.visible[id] !== false;
}

export const sameHole = (a: HoleRef, b: HoleRef) => a.layer_id === b.layer_id && a.index === b.index;
