// Sizes of the picked mounting holes and the centre-to-centre distances between them,
// shared by the 2D view's dimension overlay and the list in the Bake XCS panel.
import type { BoardView, HoleRef } from "./api";

export interface PickedHole {
  /** 1-based, in pick order: the same number on the board and in the panel. */
  n: number;
  ref: HoleRef;
  x: number;
  y: number;
  d: number;
}

export interface HolePair {
  a: PickedHole;
  b: PickedHole;
  dx: number;
  dy: number;
  dist: number;
}

/** Every pair up to this many holes (a rectangle gets its sides and both diagonals); a chain beyond. */
const ALL_PAIRS_MAX = 4;

export function pickedHoles(board: BoardView | null, refs: HoleRef[]): PickedHole[] {
  if (!board) return [];
  const out: PickedHole[] = [];
  for (const ref of refs) {
    const hole = board.layers.find((l) => l.id === ref.layer_id)?.holes?.[ref.index];
    if (hole) out.push({ n: out.length + 1, ref, x: hole[0], y: hole[1], d: hole[2] });
  }
  return out;
}

export function holePairs(holes: PickedHole[]): HolePair[] {
  const pair = (a: PickedHole, b: PickedHole): HolePair => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { a, b, dx, dy, dist: Math.hypot(dx, dy) };
  };
  const out: HolePair[] = [];
  if (holes.length <= ALL_PAIRS_MAX) {
    for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) out.push(pair(holes[i], holes[j]));
  } else {
    for (let i = 1; i < holes.length; i++) out.push(pair(holes[i - 1], holes[i]));
  }
  return out;
}
