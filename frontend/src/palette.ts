// Risograph inks — spot colours that overprint (the 2D view multiplies them like real ink).
// Mirrored as CSS custom properties in styles/riso.css.
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

export interface LayerStyle {
  color: string;
  opacity: number;
}

export const ROLE_STYLE: Record<string, LayerStyle> = {
  top_copper: { color: ink.blue, opacity: 0.9 },
  bottom_copper: { color: ink.pink, opacity: 0.85 },
  top_silk: { color: ink.ink, opacity: 0.9 },
  bottom_silk: { color: ink.ink2, opacity: 0.85 },
  top_mask: { color: ink.green, opacity: 0.55 },
  bottom_mask: { color: ink.orange, opacity: 0.55 },
  top_paste: { color: ink.yellow, opacity: 0.9 },
  bottom_paste: { color: ink.yellow, opacity: 0.7 },
  inner_copper: { color: ink.purple, opacity: 0.6 },
  outline: { color: ink.ink, opacity: 1 },
  drill: { color: ink.ink, opacity: 1 },
  other: { color: ink.ink3, opacity: 0.5 },
};

export function styleFor(role: string): LayerStyle {
  return ROLE_STYLE[role] ?? ROLE_STYLE.other;
}
