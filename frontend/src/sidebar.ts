import type { LayerView } from "./api";
import { styleFor } from "./palette";
import { isVisible, state, update } from "./state";

const GROUPS: { title: string; roles: string[] }[] = [
  { title: "Front", roles: ["top_copper", "top_mask", "top_silk", "top_paste"] },
  { title: "Back", roles: ["bottom_copper", "bottom_mask", "bottom_silk", "bottom_paste"] },
  { title: "Board", roles: ["outline", "drill", "inner_copper"] },
  { title: "Other", roles: ["other"] },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderLayerList(onRoleChange: (layerId: string, role: string) => void) {
  const list = document.getElementById("layer-list")!;
  list.replaceChildren();
  const board = state.board;
  if (!board) return;

  for (const group of GROUPS) {
    const layers = board.layers
      .filter((l) => group.roles.includes(l.role))
      .sort((a, b) => group.roles.indexOf(a.role) - group.roles.indexOf(b.role));
    if (!layers.length) continue;
    const g = el("div", "layer-group");
    g.append(el("div", "group-title", group.title));
    layers.forEach((l) => g.append(layerRow(l, onRoleChange)));
    list.append(g);
  }
}

function layerRow(l: LayerView, onRoleChange: (layerId: string, role: string) => void) {
  const row = el("div", "layer");
  const on = isVisible(l.id);
  row.classList.toggle("off", !on);

  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = on;
  cb.setAttribute("aria-label", `Show ${l.label} (${l.filename})`);
  cb.addEventListener("change", () => {
    update({ visible: { ...state.visible, [l.id]: cb.checked } });
  });

  const sw = el("span", "swatch");
  if (l.role === "drill") sw.classList.add("ring");
  else if (l.role === "outline") sw.classList.add("line");
  else sw.style.background = styleFor(l.role).color;

  const text = el("div", "layer-text");
  text.append(el("div", "layer-name", l.label), el("div", "layer-file", l.filename));
  text.title = l.filename;

  const sel = el("select");
  sel.setAttribute("aria-label", `Layer type for ${l.filename}`);
  const roles = state.config?.roles ?? [];
  for (const r of roles) {
    // Excellon files can only be drill; gerbers can be anything but drill.
    if (l.format === "excellon" && r.id !== "drill") continue;
    if (l.format !== "excellon" && r.id === "drill") continue;
    const o = el("option", undefined, r.label);
    o.value = r.id;
    o.selected = r.id === l.role;
    sel.append(o);
  }
  sel.disabled = l.format === "excellon";
  sel.addEventListener("change", () => onRoleChange(l.id, sel.value));

  row.append(cb, sw, text, sel);
  return row;
}

export function renderBoardMeta() {
  const meta = document.getElementById("board-meta")!;
  const card = document.getElementById("upload")!;
  const b = state.board;
  meta.hidden = !b;
  card.classList.toggle("compact", !!b);
  if (!b) return;
  const holes = b.layers.reduce((n, l) => n + (l.holes?.length ?? 0) + (l.slots?.length ?? 0), 0);
  meta.replaceChildren();
  const name = el("div", "name", b.name);
  const dl = el("dl", "board-meta");
  dl.style.margin = "0";
  const rows: [string, string][] = [
    ["Size", `${b.board.width.toFixed(2)} × ${b.board.height.toFixed(2)} mm`],
    ["Layers", `${b.layers.length} files`],
    ["Holes", `${holes}`],
  ];
  for (const [k, v] of rows) dl.append(el("dt", undefined, k), el("dd", undefined, v));
  meta.append(name, dl);
}

export function renderNotes() {
  const notes = document.getElementById("notes")!;
  notes.replaceChildren();
  if (state.error) {
    const s = el("div", "sticky error");
    s.append(el("b", undefined, "Couldn't do that. "), document.createTextNode(state.error));
    notes.append(s);
  }
  const b = state.board;
  if (!b) return;
  if (b.warnings.length) {
    const s = el("div", "sticky");
    s.append(el("b", undefined, "Heads up"));
    const ul = el("ul");
    b.warnings.forEach((w) => ul.append(el("li", undefined, w)));
    s.append(ul);
    notes.append(s);
  }
  if (b.ignored.length) {
    const s = el("div", "sticky");
    s.append(el("b", undefined, "Skipped (not Gerber/drill): "), document.createTextNode(b.ignored.join(", ")));
    notes.append(s);
  }
}
