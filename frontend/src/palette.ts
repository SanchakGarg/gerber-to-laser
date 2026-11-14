// Notebook palette — paper, ruled lines, inks, pencil and highlighters.
// Mirrored as CSS custom properties in styles/notebook.css.
export const paper = {
  paper: "#fbf8ef",
  paperDeep: "#f3eddc",
  rule: "#cfdced",
  margin: "#e0675f",
  ink: "#2b4c9b",
  inkSoft: "#5b74b5",
  graphite: "#4a4a48",
  graphiteSoft: "#8a8a86",
  hlYellow: "#f6e05e",
  hlGreen: "#a8dd8c",
  hlPink: "#f2a7c3",
  hlViolet: "#c5b4ee",
  marker: "#e48a3a",
  kraft: "#e8d9b0",
  kraftEdge: "#cdb98a",
};

export interface LayerStyle {
  color: string;
  opacity: number;
}

export const ROLE_STYLE: Record<string, LayerStyle> = {
  top_copper: { color: paper.ink, opacity: 0.85 },
  bottom_copper: { color: paper.marker, opacity: 0.75 },
  top_silk: { color: paper.graphite, opacity: 0.95 },
  bottom_silk: { color: paper.graphiteSoft, opacity: 0.9 },
  top_mask: { color: paper.hlGreen, opacity: 0.6 },
  bottom_mask: { color: paper.hlPink, opacity: 0.6 },
  top_paste: { color: paper.hlYellow, opacity: 0.8 },
  bottom_paste: { color: paper.hlYellow, opacity: 0.6 },
  inner_copper: { color: paper.hlViolet, opacity: 0.6 },
  outline: { color: paper.margin, opacity: 1 },
  drill: { color: paper.ink, opacity: 1 },
  other: { color: paper.graphiteSoft, opacity: 0.5 },
};

export function styleFor(role: string): LayerStyle {
  return ROLE_STYLE[role] ?? ROLE_STYLE.other;
}
