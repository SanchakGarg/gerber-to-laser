import type { LayerView } from "./api";
import { stampIn } from "./motion";
import { styleFor } from "./palette";
import { isVisible, state, update } from "./state";
import { h, icon } from "./ui";

const GROUPS: { title: string; roles: string[] }[] = [
  { title: "Front", roles: ["top_copper", "top_mask", "top_silk", "top_paste"] },
  { title: "Back", roles: ["bottom_copper", "bottom_mask", "bottom_silk", "bottom_paste"] },
  { title: "Board", roles: ["outline", "drill", "inner_copper"] },
  { title: "Other", roles: ["other"] },
];

function eyeButton(on: boolean, label: string, onToggle: () => void, cls = "eye") {
  const b = h("button", { type: "button", class: cls, "aria-pressed": String(on), "aria-label": label, title: label });
  b.append(icon(on ? "eye" : "eyeOff"));
  b.addEventListener("click", onToggle);
  return b;
}

export function renderLayerList(onRoleChange: (layerId: string, role: string) => void, animate = false) {
  const list = document.getElementById("layer-list")!;
  list.replaceChildren();
  const board = state.board;
  if (!board) return;

  for (const group of GROUPS) {
    const layers = board.layers
      .filter((l) => group.roles.includes(l.role))
      .sort((a, b) => group.roles.indexOf(a.role) - group.roles.indexOf(b.role));
    if (!layers.length) continue;
    const allOn = layers.every((l) => isVisible(l.id));
    const head = h("div", { class: "group-head" },
      h("span", { class: "group-title" }, group.title),
      h("span", { class: "group-count" }, String(layers.length)),
      eyeButton(allOn, `${allOn ? "Hide" : "Show"} all ${group.title.toLowerCase()} layers`, () => {
        const visible = { ...state.visible };
        layers.forEach((l) => (visible[l.id] = !allOn));
        update({ visible });
      }, "eye eye-group"),
    );
    const g = h("div", { class: "layer-group" }, head);
    layers.forEach((l) => g.append(layerRow(l, onRoleChange)));
    list.append(g);
  }
  if (animate) stampIn(list, ".layer");
}

function layerRow(l: LayerView, onRoleChange: (layerId: string, role: string) => void) {
  const on = isVisible(l.id);
  const row = h("div", { class: `layer${on ? "" : " off"}` });

  const eye = eyeButton(on, `${on ? "Hide" : "Show"} ${l.label} (${l.filename})`, () =>
    update({ visible: { ...state.visible, [l.id]: !on } }),
  );

  const sw = h("span", { class: "swatch" });
  if (l.role === "drill") sw.classList.add("ring");
  else if (l.role === "outline") sw.classList.add("line");
  else sw.style.setProperty("--c", styleFor(l.role).color);

  const text = h("div", { class: "layer-text", title: l.filename },
    h("div", { class: "layer-name" }, l.label),
    h("div", { class: "layer-file" }, l.filename),
  );

  const sel = h("select", { "aria-label": `Layer type for ${l.filename}` });
  for (const r of state.config?.roles ?? []) {
    // Excellon files can only be drill; gerbers can be anything but drill.
    if (l.format === "excellon" && r.id !== "drill") continue;
    if (l.format !== "excellon" && r.id === "drill") continue;
    const o = h("option", { value: r.id }, r.label);
    o.selected = r.id === l.role;
    sel.append(o);
  }
  sel.disabled = l.format === "excellon";
  sel.addEventListener("change", () => onRoleChange(l.id, sel.value));

  row.append(eye, sw, text, sel);
  return row;
}

/** The upload card turns into a "ticket" for the loaded board. */
export function renderTicket() {
  const meta = document.getElementById("board-meta")!;
  const card = document.getElementById("upload")!;
  const b = state.board;
  meta.hidden = !b;
  card.classList.toggle("compact", !!b);
  meta.replaceChildren();
  if (!b) return;
  const holes = b.layers.reduce((n, l) => n + (l.holes?.length ?? 0), 0);
  const slots = b.layers.reduce((n, l) => n + (l.slots?.length ?? 0), 0);
  const stat = (k: string, v: string) => h("div", { class: "stat" }, h("dt", {}, k), h("dd", {}, v));
  meta.append(
    h("div", { class: "ticket-name" }, b.name),
    h("dl", { class: "ticket-stats" },
      stat("Size", `${+b.board.width.toFixed(1)} × ${+b.board.height.toFixed(1)} mm`),
      stat("Files", String(b.layers.length)),
      stat("Holes", slots ? `${holes} + ${slots} slots` : String(holes)),
      stat("Sides", b.sides_present.length === 2 ? "2" : b.sides_present.join(" ") || "—"),
    ),
  );
}

export function renderNotes() {
  const notes = document.getElementById("notes")!;
  notes.replaceChildren();
  if (state.error) {
    notes.append(h("div", { class: "sticky error", role: "alert" },
      h("b", {}, "Oops. "), state.error));
  }
  const b = state.board;
  if (!b) return;
  if (b.warnings.length) {
    const ul = h("ul");
    b.warnings.forEach((w) => ul.append(h("li", {}, w)));
    notes.append(h("div", { class: "sticky" }, h("b", {}, "Heads up"), ul));
  }
  if (b.ignored.length) {
    notes.append(h("div", { class: "sticky muted" },
      h("b", {}, "Skipped (not Gerber/drill): "), b.ignored.join(", ")));
  }
}
