// Risograph inks — spot colours that overprint (the 2D view multiplies them like real ink).
// The values come from the active theme's CSS custom properties (styles/themes.css):
// readInk() refreshes them after the theme changes. The defaults are the "riso" theme.
export const ink = {
  paper: "#f4efe6",
  paper2: "#ebe3d3",
  paper3: "#fffaf0",
  ink: "#1d1d1b",
  ink2: "#4a4843",
  ink3: "#8b867b",
  pink: "#ff48b0",
  blue: "#0078bf",
  yellow: "#ffe800",
  green: "#00a95c",
  orange: "#ff6c2f",
  purple: "#765ba7",
  board: "#e8dcc0",
  mount: "#a23cf0",
};

const CSS_VAR: Record<keyof typeof ink, string> = {
  paper: "--paper", paper2: "--paper-2", paper3: "--paper-3",
  ink: "--ink", ink2: "--ink-2", ink3: "--ink-3",
  pink: "--pink", blue: "--blue", yellow: "--yellow", green: "--green", orange: "--orange", purple: "--purple",
  board: "--board", mount: "--mount",
};

export function readInk() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of Object.keys(CSS_VAR) as (keyof typeof ink)[]) {
    const v = cs.getPropertyValue(CSS_VAR[k]).trim();
    if (v) ink[k] = v;
  }
}

export interface LayerStyle {
  color: string;
  opacity: number;
}

const ROLE_INK: Record<string, [keyof typeof ink, number]> = {
  top_copper: ["blue", 0.9],
  bottom_copper: ["pink", 0.85],
  top_silk: ["ink", 0.9],
  bottom_silk: ["ink2", 0.85],
  top_mask: ["green", 0.55],
  bottom_mask: ["orange", 0.55],
  top_paste: ["yellow", 0.9],
  bottom_paste: ["yellow", 0.7],
  inner_copper: ["purple", 0.6],
  outline: ["ink", 1],
  drill: ["ink", 1],
  other: ["ink3", 0.5],
};

export function styleFor(role: string): LayerStyle {
  const [key, opacity] = ROLE_INK[role] ?? ROLE_INK.other;
  return { color: ink[key], opacity };
}
