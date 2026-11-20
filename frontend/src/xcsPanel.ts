// "Bake XCS": live preview of the two xTool projects (front / back), per-layer show/hide,
// cut/etch offsets, mounting holes and the download links.
import type { Side, XcsLayerSpec, XcsOpts } from "./api";
import { api } from "./api";
import { holePairs, pickedHoles } from "./measure";
import { burst, flash, reducedMotion, stampIn } from "./motion";
import { isHidden, setXcsOpts, state, update, type State } from "./state";
import { fmtBytes, fmtMm, h, icon, svgEl, toast } from "./ui";

const SIDES: Side[] = ["front", "back"];
const SIDE_LABEL: Record<Side, string> = { front: "Front", back: "Back" };
const GROUP_LABEL = { cut: "Cut laser", etch: "Etch laser" } as const;
const STEP_MM = 0.05;
const REG_SCALE = 30; // registration widget: px per mm
// Draw fills first, cuts on top, jig marks last.
const DRAW_ORDER = ["copper", "silk", "mask", "hole_engrave", "hole_cut", "outline_cut", "mounting"];

type Group = keyof XcsOpts["offsets"];
type DlKind = Side | "zip";

interface Bed {
  card: HTMLElement;
  svg: SVGSVGElement;
  zoomG: SVGGElement;
  layersG: SVGGElement;
  list: HTMLElement;
  fileChip: HTMLElement;
  drawn: Map<string, { g: SVGGElement; d: string }>;
  zoomed: boolean;
  zoomBtn: HTMLButtonElement;
}

let host: HTMLElement;
let onPickToggle: () => void = () => {};
let built = false;
let body: HTMLElement;
let empty: HTMLElement;
const beds = {} as Record<Side, Bed>;
const dl = {} as Record<DlKind, HTMLAnchorElement>;
const offsetInputs = {} as Record<Group, [HTMLInputElement, HTMLInputElement]>;
const regMarks = {} as Record<Group, SVGGElement>;
let mountCount: HTMLElement;
let mountDiam: HTMLInputElement;
let mountClear: HTMLButtonElement;
let mountPick: HTMLButtonElement;
let mountDimsToggle: HTMLInputElement;
let mountList: HTMLElement;
let tolInput: HTMLInputElement;
let invertInput: HTMLInputElement;
let statusEl: HTMLElement;

const specs = () => state.config?.xcs.layers ?? [];
const spec = (key: string) => specs().find((l) => l.key === key);
const maxOffset = () => state.config?.xcs.max_offset_mm ?? 10;
const bedSize = () => state.config?.xcs.bed ?? { w: 220, h: 220 };
const stampLabel = (s: XcsLayerSpec) => (s.process === "cut" ? "cut" : s.key === "silk" || s.key === "mask" ? "etch" : "engrave");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function initXcsPanel(el: HTMLElement, pickToggle: () => void) {
  host = el;
  onPickToggle = pickToggle;
}

// ---------- refresh (debounced) ----------

let timer = 0;
let seq = 0;

/** Rebuild the preview and the files after options change; links stay disabled until it lands. */
export function scheduleXcs(delay = 260) {
  if (!state.board) return;
  if (!state.xcsPending) update({ xcsPending: true });
  clearTimeout(timer);
  timer = window.setTimeout(runXcs, delay);
}

async function runXcs() {
  const board = state.board;
  if (!board) return;
  const mine = ++seq;
  try {
    const xcs = await api.xcs(board.session_id, state.xcsOpts, state.mounting);
    if (mine !== seq || state.board !== board) return;
    update({ xcs, xcsPending: false, xcsError: null });
  } catch (e) {
    if (mine !== seq) return;
    console.error(e);
    update({ xcsPending: false, xcsError: (e as Error).message });
  }
}

// ---------- build once ----------

function build() {
  const { w, h: bh } = bedSize();
  built = true;

  empty = h("div", { class: "xcs-empty" },
    h("div", { class: "riso-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    h("p", {}, h("b", {}, "Nothing in the oven yet."), " Drop a board and two xTool projects bake here: one for the front, one for the back."),
  );

  const bedsWrap = h("div", { class: "beds" });
  for (const side of SIDES) {
    beds[side] = bedCard(side, w, bh);
    bedsWrap.append(beds[side].card);
  }

  // offsets
  const regSvg = svgEl("svg", { class: "reg", viewBox: "-60 -60 120 120", role: "img", "aria-label": "Offset registration, magnified" });
  regSvg.append(
    svgEl("circle", { class: "reg-ring", r: 30 }),
    svgEl("circle", { class: "reg-ring", r: 15 }),
    svgEl("path", { class: "reg-nominal", d: "M -56 0 H 56 M 0 -56 V 56" }),
  );
  for (const g of ["etch", "cut"] as Group[]) {
    const m = svgEl("g", { class: `reg-mark reg-${g}` });
    m.append(svgEl("circle", { r: 7 }), svgEl("path", { d: "M -13 0 H 13 M 0 -13 V 13" }));
    regMarks[g] = m;
    regSvg.append(m);
  }
  const resetBtn = h("button", { type: "button", class: "btn btn-ghost btn-small", title: "Set all offsets to 0" }, icon("reset"), "Reset");
  resetBtn.addEventListener("click", () => {
    setXcsOpts({ offsets: { cut: [0, 0], etch: [0, 0] } });
    scheduleXcs();
  });
  const offsets = h("section", { class: "block offsets" },
    h("div", { class: "block-head" }, h("h3", {}, "Laser offsets"), resetBtn),
    h("p", { class: "hint" }, "The cut and etch lasers don't land on exactly the same spot. Nudge each group until they line up."),
    h("div", { class: "offsets-grid" },
      h("div", { class: "offset-rows" }, offsetRow("cut"), offsetRow("etch")),
      h("figure", { class: "reg-wrap" }, regSvg, h("figcaption", {}, `×${REG_SCALE} zoom`)),
    ),
  );

  // mounting
  mountCount = h("span", { class: "count-badge" }, "0");
  mountPick = h("button", { type: "button", class: "btn btn-pick", "aria-pressed": "false" }, icon("target"), "Pick holes");
  mountPick.addEventListener("click", () => onPickToggle());
  mountClear = h("button", { type: "button", class: "btn btn-ghost btn-small" }, "Clear");
  mountClear.addEventListener("click", () => {
    update({ mounting: [] });
    scheduleXcs();
  });
  mountDiam = h("input", { type: "number", min: 0.5, max: 10, step: 0.1, inputmode: "decimal", "aria-label": "Jig hole diameter in mm" });
  mountDiam.addEventListener("change", () => {
    const v = parseFloat(mountDiam.value);
    if (Number.isFinite(v)) {
      setXcsOpts({ mounting_diameter: clamp(Math.round(v * 100) / 100, 0.5, 10) });
      scheduleXcs();
    }
    mountDiam.value = String(state.xcsOpts.mounting_diameter);
  });
  mountDimsToggle = h("input", { type: "checkbox" });
  mountDimsToggle.addEventListener("change", () => update({ showDims: mountDimsToggle.checked }));
  mountList = h("div", { class: "mdims", hidden: true });
  const mounting = h("section", { class: "block mount" },
    h("div", { class: "block-head" }, h("h3", {}, "Mounting holes ", mountCount), mountClear),
    h("p", { class: "hint" }, "Pick holes to get small jig holes at their centres, on their own layer, placed with the cut offset so the flipped back side lines up. Those holes still get cut at full size in the hole layers."),
    h("div", { class: "row" }, mountPick, h("label", { class: "inline-field" }, "Ø", mountDiam, "mm")),
    h("label", { class: "check mdims-toggle" }, mountDimsToggle, h("span", { class: "box", "aria-hidden": "true" }),
      "Dimensions on board", h("small", {}, "hole sizes, distances")),
    mountList,
  );

  // options
  tolInput = h("input", { type: "number", min: -2, max: 2, step: 0.05, inputmode: "decimal", "aria-label": "Hole tolerance in mm" });
  tolInput.addEventListener("change", () => {
    const v = parseFloat(tolInput.value);
    setXcsOpts({ hole_tolerance: Number.isFinite(v) ? clamp(v, -2, 2) : 0 });
    tolInput.value = String(state.xcsOpts.hole_tolerance);
    scheduleXcs();
  });
  invertInput = h("input", { type: "checkbox" });
  invertInput.addEventListener("change", () => {
    setXcsOpts({ invert_copper: invertInput.checked });
    scheduleXcs();
  });
  const options = h("section", { class: "block opts" },
    h("label", { class: "inline-field" }, "Holes cut", tolInput, "mm smaller"),
    h("label", { class: "check" }, invertInput, h("span", { class: "box", "aria-hidden": "true" }), "Invert copper", h("small", {}, "burn the traces instead")),
  );

  // downloads
  const dls = h("div", { class: "downloads" });
  for (const kind of ["front", "back", "zip"] as DlKind[]) {
    dl[kind] = dlLink(kind);
    dls.append(dl[kind]);
  }
  statusEl = h("div", { class: "xcs-status", role: "status" });

  const more = h("details", { class: "more" },
    h("summary", {}, h("span", {}, "More formats"), h("small", {}, "SVG / PNG zip")),
    h("div", { id: "more-formats" }),
  );

  body = h("div", { class: "xcs-body" }, bedsWrap, offsets, mounting, options, statusEl, dls, more);
  host.replaceChildren(
    h("header", { class: "card-head" },
      h("h2", { class: "riso-title", "data-text": "Bake XCS" }, "Bake XCS"),
      h("span", { class: "sticker" }, `xTool · ${w} × ${bh} mm bed`),
    ),
    empty,
    body,
  );
}

function bedCard(side: Side, w: number, bh: number): Bed {
  const svg = svgEl("svg", { class: "bed", viewBox: `0 0 ${w} ${bh}`, role: "img", "aria-label": `${SIDE_LABEL[side]} laser bed preview` });
  const defs = svgEl("defs");
  const pat = svgEl("pattern", { id: `bedgrid-${side}`, width: 10, height: 10, patternUnits: "userSpaceOnUse" });
  pat.append(svgEl("path", { d: "M 10 0 H 0 V 10", class: "bed-grid" }));
  defs.append(pat);
  const zoomG = svgEl("g", { class: "bed-zoom" });
  const layersG = svgEl("g", { class: "bed-layers" });
  zoomG.append(
    svgEl("rect", { width: w, height: bh, fill: `url(#bedgrid-${side})`, class: "bed-sheet" }),
    svgEl("path", { class: "bed-center", d: `M ${w / 2} 0 V ${bh} M 0 ${bh / 2} H ${w}` }),
    layersG,
  );
  svg.append(defs, zoomG);

  const zoomBtn = h("button", { type: "button", class: "bed-zoom-btn", title: "Toggle whole bed / board" }, icon("zoom"));
  const fileChip = h("span", { class: "file-chip" }, `${side}.xcs`);
  const list = h("ul", { class: "xlayers" });
  const card = h("article", { class: `bed-card side-${side}` },
    h("div", { class: "bed-head" }, h("h3", {}, SIDE_LABEL[side]), fileChip),
    h("div", { class: "bed-figure" }, svg, zoomBtn),
    list,
  );
  const bed: Bed = { card, svg, zoomG, layersG, list, fileChip, drawn: new Map(), zoomed: true, zoomBtn };
  zoomBtn.addEventListener("click", () => {
    bed.zoomed = !bed.zoomed;
    applyZoom(bed);
  });
  return bed;
}

function offsetRow(group: Group) {
  const row = h("div", { class: `offset-row og-${group}` },
    h("span", { class: "og-label" }, h("i", { class: "og-dot", "aria-hidden": "true" }), GROUP_LABEL[group]));
  const inputs: HTMLInputElement[] = [];
  for (const axis of [0, 1] as const) {
    const input = h("input", {
      type: "number", step: STEP_MM, min: -maxOffset(), max: maxOffset(), inputmode: "decimal",
      "aria-label": `${GROUP_LABEL[group]} offset ${axis ? "Y" : "X"} in mm`,
    });
    const minus = h("button", { type: "button", class: "step", "aria-label": `${axis ? "Y" : "X"} −${STEP_MM} mm` }, icon("minus"));
    const plus = h("button", { type: "button", class: "step", "aria-label": `${axis ? "Y" : "X"} +${STEP_MM} mm` }, icon("plus"));
    const cur = () => state.xcsOpts.offsets[group][axis];
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) setOffset(group, axis, v);
    });
    input.addEventListener("change", () => (input.value = fmtMm(cur())));
    minus.addEventListener("click", () => setOffset(group, axis, cur() - STEP_MM, true));
    plus.addEventListener("click", () => setOffset(group, axis, cur() + STEP_MM, true));
    row.append(h("label", { class: "stepper" }, h("span", { class: "axis" }, axis ? "Δy" : "Δx"), minus, input, plus));
    inputs.push(input);
  }
  offsetInputs[group] = inputs as [HTMLInputElement, HTMLInputElement];
  return row;
}

function setOffset(group: Group, axis: 0 | 1, v: number, writeInput = false) {
  const m = maxOffset();
  const pair = [...state.xcsOpts.offsets[group]] as [number, number];
  pair[axis] = clamp(Math.round(v * 1000) / 1000, -m, m);
  setXcsOpts({ offsets: { ...state.xcsOpts.offsets, [group]: pair } });
  if (writeInput) offsetInputs[group][axis].value = fmtMm(pair[axis]);
  scheduleXcs();
}

function dlLink(kind: DlKind) {
  const label = kind === "zip" ? "Both" : `${SIDE_LABEL[kind]}`;
  const ext = kind === "zip" ? ".zip" : ".xcs";
  const a = h("a", { class: `dl dl-${kind}`, "aria-disabled": "true" },
    h("span", { class: "dl-icon" }, icon("download")),
    h("span", { class: "dl-name" }, label, h("small", {}, ext)),
    h("span", { class: "dl-meta" }, "…"),
  );
  a.addEventListener("click", (e) => {
    if (a.getAttribute("aria-disabled") === "true" || !a.getAttribute("href")) {
      e.preventDefault();
      return;
    }
    // A real link to a GET with Content-Disposition: the browser's own download manager saves it.
    burst(e.clientX, e.clientY);
    toast(`Saving ${a.download}`);
    if (!state.downloaded) update({ downloaded: true });
  });
  return a;
}

// ---------- render ----------

export function renderXcsPanel(changed: Set<keyof State>) {
  if (!state.config) return;
  const first = !built;
  if (first) build();
  const all = first || changed.has("config");

  if (all || changed.has("board")) {
    const has = !!state.board;
    empty.hidden = has;
    body.hidden = !has;
    for (const side of SIDES) {
      beds[side].drawn.clear();
      beds[side].layersG.replaceChildren();
      beds[side].zoomed = true;
    }
    if (has) stampIn(body, ":scope > *");
  }
  if (all || changed.has("board") || changed.has("xcs")) drawBeds(changed.has("board"));
  if (all || changed.has("xcsOpts") || changed.has("xcs")) syncHidden();
  if (all || changed.has("xcsOpts")) {
    syncOffsets();
    syncOptions();
  }
  if (all || ["xcsOpts", "mounting", "pickMode", "showDims", "board"].some((k) => changed.has(k as keyof State))) syncMounting();
  if (all || changed.has("xcs") || changed.has("xcsPending") || changed.has("xcsError") || changed.has("board")) {
    syncDownloads();
    syncStatus();
  }
}

function drawBeds(fresh: boolean) {
  for (const side of SIDES) {
    const bed = beds[side];
    const res = state.xcs?.sides[side];
    if (!res) {
      bed.list.replaceChildren(h("li", { class: "xrow skeleton" }, "Inking preview…"));
      continue;
    }
    // paths: keep unchanged ones (offset nudges don't change geometry)
    const keep = new Set<string>();
    const byKey = new Map(res.layers.map((l) => [l.key, l]));
    for (const key of DRAW_ORDER) {
      const l = byKey.get(key);
      const sp = spec(key);
      if (!l || !sp) continue;
      keep.add(key);
      let item = bed.drawn.get(key);
      if (!item || item.d !== l.d) {
        item?.g.remove();
        const g = svgEl("g", { class: `xl xl-${sp.process}`, "data-key": key, "data-group": sp.group });
        g.style.setProperty("--c", sp.color);
        g.append(svgEl("path", { d: l.d, "fill-rule": "evenodd", "vector-effect": "non-scaling-stroke" }));
        item = { g, d: l.d };
        bed.drawn.set(key, item);
      }
      bed.layersG.append(item.g); // (re)append keeps draw order
    }
    for (const [key, item] of bed.drawn) {
      if (!keep.has(key)) {
        item.g.remove();
        bed.drawn.delete(key);
      }
    }

    // layer list
    bed.list.replaceChildren();
    for (const l of res.layers) {
      const sp = spec(l.key);
      if (!sp) continue;
      // the stamp already says cut / engrave / etch: show the short name ("Copper · engrave" → "Copper")
      const short = sp.name.split(" · ")[0];
      const name = l.key === "mounting" ? `Jig holes Ø${state.xcsOpts.mounting_diameter}` : short;
      const eye = h("button", { type: "button", class: "eye", "data-key": l.key });
      eye.addEventListener("click", () => toggleHidden(side, l.key));
      const row = h("li", { class: "xrow", "data-key": l.key },
        eye,
        h("span", { class: "chip", "aria-hidden": "true" }),
        h("span", { class: "xname", title: l.key === "mounting" ? `${sp.name} · Ø${state.xcsOpts.mounting_diameter} mm` : sp.name }, name),
        h("span", { class: `stamp stamp-${sp.process}` }, stampLabel(sp)),
        h("span", { class: "count", title: `${l.count} shape${l.count === 1 ? "" : "s"}` }, `×${l.count}`),
      );
      row.style.setProperty("--c", sp.color);
      bed.list.append(row);
    }
    if (fresh) stampIn(bed.list);
    applyZoom(bed);
  }
  applyOffsets();
}

function toggleHidden(side: Side, key: string) {
  const list = state.xcsOpts.hidden[side];
  const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  setXcsOpts({ hidden: { ...state.xcsOpts.hidden, [side]: next } });
  scheduleXcs();
}

function syncHidden() {
  for (const side of SIDES) {
    const bed = beds[side];
    for (const [key, { g }] of bed.drawn) g.classList.toggle("off", isHidden(side, key));
    bed.list.querySelectorAll<HTMLElement>(".xrow[data-key]").forEach((row) => {
      const key = row.dataset.key!;
      const off = isHidden(side, key);
      row.classList.toggle("off", off);
      const eye = row.querySelector<HTMLButtonElement>(".eye")!;
      eye.setAttribute("aria-pressed", String(!off));
      const label = `${off ? "Include" : "Leave out"} ${spec(key)?.name ?? key} (${side})`;
      eye.setAttribute("aria-label", label);
      eye.title = label;
      eye.replaceChildren(icon(off ? "eyeOff" : "eye"));
    });
  }
}

function applyOffsets() {
  const o = state.xcsOpts.offsets;
  for (const side of SIDES) {
    for (const { g } of beds[side].drawn.values()) {
      const [dx, dy] = o[(g.dataset.group as Group) ?? "etch"];
      g.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    }
  }
  const lim = 56 / REG_SCALE;
  for (const g of ["cut", "etch"] as Group[]) {
    const [dx, dy] = o[g];
    regMarks[g].style.transform = `translate(${clamp(dx, -lim, lim) * REG_SCALE}px, ${clamp(dy, -lim, lim) * REG_SCALE}px)`;
  }
}

function applyZoom(bed: Bed) {
  const b = state.board?.board;
  const { w, h: bh } = bedSize();
  let s = 1;
  if (bed.zoomed && b && b.width > 0 && b.height > 0) s = Math.max(1, Math.min(w / (b.width * 1.3), bh / (b.height * 1.3)));
  bed.zoomG.style.transform = s === 1 ? "" : `scale(${s})`;
  bed.zoomBtn.setAttribute("aria-pressed", String(bed.zoomed));
  bed.zoomBtn.title = bed.zoomed ? "Show the whole bed" : "Zoom to the board";
}

function syncOffsets() {
  for (const g of ["cut", "etch"] as Group[]) {
    offsetInputs[g].forEach((input, axis) => {
      if (document.activeElement !== input) input.value = fmtMm(state.xcsOpts.offsets[g][axis]);
    });
  }
  applyOffsets();
}

function syncOptions() {
  if (document.activeElement !== tolInput) tolInput.value = String(state.xcsOpts.hole_tolerance);
  invertInput.checked = state.xcsOpts.invert_copper;
}

function syncMounting() {
  const n = state.mounting.length;
  if (mountCount.textContent !== String(n)) {
    mountCount.textContent = String(n);
    flash(mountCount, "pop");
  }
  mountCount.classList.toggle("zero", n === 0);
  mountClear.disabled = n === 0;
  mountPick.setAttribute("aria-pressed", String(state.pickMode));
  mountPick.classList.toggle("active", state.pickMode);
  mountPick.lastChild!.textContent = state.pickMode ? "Done picking" : "Pick holes";
  if (document.activeElement !== mountDiam) mountDiam.value = String(state.xcsOpts.mounting_diameter);
  mountDimsToggle.checked = state.showDims;
  renderMountList();
}

/** Each picked hole's drilled size and position, then the centre-to-centre distances (numbers match the board). */
function renderMountList() {
  const holes = pickedHoles(state.board, state.mounting);
  mountList.hidden = !holes.length;
  if (!holes.length) {
    mountList.replaceChildren();
    return;
  }
  const num = (n: number) => h("span", { class: "mnum" }, String(n));
  const holeRows = holes.map((p) => h("li", {},
    num(p.n),
    h("span", { class: "mdia" }, `Ø ${fmtMm(p.d)} mm`),
    h("span", { class: "mxy" }, `x ${fmtMm(p.x)} · y ${fmtMm(p.y)}`),
  ));
  const pairRows = holePairs(holes).map((p) => h("li", {},
    h("span", { class: "mpair" }, num(p.a.n), h("span", { class: "mto", "aria-label": "to" }, "↔"), num(p.b.n)),
    h("b", { class: "mdist" }, `${fmtMm(p.dist)} mm`),
    h("span", { class: "mxy" }, `Δx ${fmtMm(Math.abs(p.dx))} · Δy ${fmtMm(Math.abs(p.dy))}`),
  ));
  mountList.replaceChildren(h("ol", { class: "mlist", "aria-label": "Picked holes" }, ...holeRows));
  if (pairRows.length) {
    mountList.append(
      h("p", { class: "mlist-head" }, "Centre to centre"),
      h("ul", { class: "mlist", "aria-label": "Centre-to-centre distances" }, ...pairRows),
    );
  }
}

function syncDownloads() {
  const pending = state.xcsPending || !state.xcs;
  const links: Record<DlKind, { name: string; size: number; url: string } | null | undefined> = {
    front: state.xcs?.sides.front?.file,
    back: state.xcs?.sides.back?.file,
    zip: state.xcs?.zip,
  };
  for (const kind of ["front", "back", "zip"] as DlKind[]) {
    const a = dl[kind];
    const link = links[kind];
    const meta = a.querySelector(".dl-meta")!;
    a.classList.toggle("pending", pending);
    if (link && !pending) {
      a.href = link.url;
      a.download = link.name;
      a.setAttribute("aria-disabled", "false");
      a.removeAttribute("tabindex");
      meta.textContent = fmtBytes(link.size);
      a.title = `Save ${link.name}`;
      if (!reducedMotion()) flash(a, "printed");
    } else {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
      a.setAttribute("tabindex", "-1");
      a.setAttribute("role", "link");
      meta.textContent = pending ? "inking…" : "nothing to bake";
    }
  }
  for (const side of SIDES) {
    const f = links[side];
    beds[side].fileChip.textContent = f ? f.name : `${side}.xcs`;
    beds[side].card.classList.toggle("empty-side", !pending && !f);
  }
}

function syncStatus() {
  statusEl.replaceChildren();
  statusEl.className = "xcs-status";
  if (state.xcsError) {
    statusEl.classList.add("error");
    statusEl.append(h("b", {}, "Couldn't bake: "), state.xcsError);
  }
}
