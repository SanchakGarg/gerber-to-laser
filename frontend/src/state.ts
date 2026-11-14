import type { AppConfig, BoardView, ExportOptions } from "./api";

export interface State {
  config: AppConfig | null;
  board: BoardView | null;
  visible: Record<string, boolean>;
  busy: string | null;
  error: string | null;
  exportOpts: ExportOptions;
}

type Listener = (s: State, changed: Set<keyof State>) => void;

const listeners: Listener[] = [];

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
  },
};

export function subscribe(fn: Listener) {
  listeners.push(fn);
}

export function update(patch: Partial<State>) {
  const changed = new Set(Object.keys(patch) as (keyof State)[]);
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(state, changed));
}

// Layers hidden by default: fab/courtyard/etc. and paste (not part of the laser job).
export function defaultVisible(role: string) {
  return !["other", "top_paste", "bottom_paste", "inner_copper"].includes(role);
}

export function isVisible(id: string) {
  return state.visible[id] !== false;
}
