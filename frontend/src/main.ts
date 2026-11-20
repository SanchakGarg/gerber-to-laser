import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./styles/riso.css";
import { api, type BoardView, type HoleRef } from "./api";
import { holePairs, pickedHoles } from "./measure";
import { flash, stampIn } from "./motion";
import { initExportDefaults, initSheet, renderMoreFormats, resetMoreFormats } from "./moreFormats";
import { renderLayerList, renderNotes, renderTicket } from "./sidebar";
import { defaultVisible, hasStoredXcs, sameHole, state, subscribe, update } from "./state";
import { fmtMm, toast } from "./ui";
import { View2D } from "./view2d";
import { View3D } from "./view3d";
import { initXcsPanel, renderXcsPanel, scheduleXcs } from "./xcsPanel";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const view2d = new View2D($("view2d"), $("readout"));
const view3d = new View3D($("view3d"));
view2d.onPick = togglePick;
// The 3D canvas has no size while its tab is hidden: frame the camera again the first time it shows.
let fresh3d = true;
initXcsPanel($("xcs-card"), () => setPickMode(!state.pickMode));

// ---------- state → UI ----------

subscribe((s, changed) => {
  const has = (...k: (keyof typeof s)[]) => k.some((x) => changed.has(x));

  if (has("board")) {
    view2d.setBoard(s.board);
    view3d.setBoard(s.board);
    fresh3d = true;
    renderTicket();
    $("layers-card").hidden = !s.board;
    $<HTMLButtonElement>("pick-btn").disabled = !s.board;
  }
  if (has("board", "visible", "config")) {
    renderLayerList(changeRole, changed.has("board"));
    view2d.refreshVisibility();
    view3d.refreshVisibility();
  }
  if (has("board", "error")) renderNotes();
  if (has("busy")) showBusy(s.busy);
  if (has("view")) showView(s.view);
  if (has("pickMode", "mounting", "xcsOpts", "board", "showDims")) syncPick();
  if (has("board", "pickMode", "mounting", "downloaded")) renderSteps();
  renderXcsPanel(changed);
  if (has("exportOpts", "board", "config", "busy")) renderMoreFormats();
});

function showBusy(msg: string | null) {
  document.querySelectorAll(".busy-overlay").forEach((e) => e.remove());
  document.body.classList.toggle("is-busy", !!msg);
  if (!msg) return;
  const o = document.createElement("div");
  o.className = "busy-overlay";
  o.innerHTML = `<div class="laser" aria-hidden="true"></div><div class="busy-msg"></div>`;
  o.querySelector(".busy-msg")!.textContent = msg;
  $("viewer-body").append(o);
}

function showView(v: "2d" | "3d") {
  if (v === "3d" && fresh3d && state.board) {
    fresh3d = false;
    requestAnimationFrame(() => requestAnimationFrame(() => view3d.setCamera("iso")));
  }
  $("view2d").hidden = v !== "2d";
  $("view3d").hidden = v !== "3d";
  $("side-seg").hidden = v !== "2d";
  $("cam-seg").hidden = v !== "3d";
  $("fit-2d").hidden = v !== "2d";
  document.querySelectorAll<HTMLButtonElement>("#view-tabs [data-view]").forEach((b) => {
    const on = b.dataset.view === v;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

// ---------- mounting-hole pick mode ----------

function setPickMode(on: boolean) {
  if (on && !state.board) return;
  if (on && state.view !== "2d") update({ view: "2d" });
  update({ pickMode: on });
}

function togglePick(ref: HoleRef) {
  const exists = state.mounting.some((r) => sameHole(r, ref));
  update({ mounting: exists ? state.mounting.filter((r) => !sameHole(r, ref)) : [...state.mounting, ref] });
  scheduleXcs();
}

function syncPick() {
  const on = state.pickMode;
  document.body.classList.toggle("picking", on);
  view2d.setPickMode(on);
  view2d.setShowDims(state.showDims);
  view2d.setMounting(state.mounting, state.xcsOpts.mounting_diameter);
  const btn = $<HTMLButtonElement>("pick-btn");
  btn.setAttribute("aria-pressed", String(on));
  btn.classList.toggle("active", on);
  btn.querySelector(".label")!.textContent = on ? "Done" : "Pick mounting holes";
  $("pick-pill").hidden = !on;
  const holes = pickedHoles(state.board, state.mounting);
  const pairs = holePairs(holes);
  $("pick-count").textContent = !holes.length
    ? "none yet"
    : pairs.length === 1 ? `2 picked · ${fmtMm(pairs[0].dist)} mm apart` : `${holes.length} picked`;
}

$("pick-btn").addEventListener("click", () => setPickMode(!state.pickMode));
$("pick-done").addEventListener("click", () => setPickMode(false));
$("pick-clear").addEventListener("click", () => {
  update({ mounting: [] });
  scheduleXcs();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.pickMode && $("sheet").hidden) setPickMode(false);
});

// ---------- steps ----------

function renderSteps() {
  const s = state;
  const done: Record<string, boolean> = {
    drop: !!s.board,
    check: !!s.board,
    mount: s.mounting.length > 0,
    bake: s.downloaded,
  };
  const current = !s.board ? "drop" : s.pickMode ? "mount" : s.downloaded ? "" : "bake";
  document.querySelectorAll<HTMLElement>("#steps [data-step]").forEach((el) => {
    const k = el.dataset.step!;
    el.classList.toggle("done", done[k]);
    el.classList.toggle("current", k === current);
    el.toggleAttribute("disabled", k !== "drop" && !s.board);
  });
}

const steps: Record<string, () => void> = {
  drop: () => $<HTMLInputElement>("file-input").click(),
  check: () => focusCard($("layers-card")),
  mount: () => setPickMode(!state.pickMode),
  bake: () => focusCard($("xcs-card").querySelector<HTMLElement>(".downloads") ?? $("xcs-card")),
};
document.querySelectorAll<HTMLButtonElement>("#steps [data-step]").forEach((b) =>
  b.addEventListener("click", () => steps[b.dataset.step!]?.()),
);

function focusCard(el: HTMLElement) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  flash(el, "nudge");
}

// ---------- actions ----------

function applyBoard(board: BoardView, keepVisibility = false) {
  const visible: Record<string, boolean> = {};
  for (const l of board.layers) {
    visible[l.id] = keepVisibility && l.id in state.visible ? state.visible[l.id] : defaultVisible(l.role);
  }
  update({ visible, board, error: null });
}

async function handleFiles(files: File[]) {
  if (!files.length) return;
  update({ busy: "Reading Gerbers…", error: null });
  try {
    const board = await api.upload(files);
    resetMoreFormats();
    update({ mounting: [], pickMode: false, xcs: null, xcsError: null, downloaded: false });
    applyBoard(board);
    initExportDefaults();
    scheduleXcs(0);
    flash($("upload"), "inked");
    toast(`Loaded ${board.name}`);
  } catch (e) {
    console.error(e);
    update({ error: (e as Error).message });
  } finally {
    update({ busy: null });
  }
}

async function changeRole(layerId: string, role: string) {
  const b = state.board;
  if (!b) return;
  update({ busy: "Updating layer…" });
  try {
    const board = await api.setRole(b.session_id, layerId, role);
    update({ visible: { ...state.visible, [layerId]: defaultVisible(role) } });
    // a drill layer that changed role invalidates picked holes from it
    const drillIds = new Set(board.layers.filter((l) => l.role === "drill").map((l) => l.id));
    update({ mounting: state.mounting.filter((r) => drillIds.has(r.layer_id)) });
    applyBoard(board, true);
    scheduleXcs(0);
  } catch (e) {
    console.error(e);
    update({ error: (e as Error).message });
    renderLayerList(changeRole); // revert the select
  } finally {
    update({ busy: null });
  }
}

// ---------- wiring ----------

const input = $<HTMLInputElement>("file-input");
input.addEventListener("change", () => {
  handleFiles([...(input.files ?? [])]);
  input.value = "";
});

const drop = $("drop");
for (const ev of ["dragenter", "dragover"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  handleFiles(await filesFromDrop(dt));
});
// Dropping anywhere else on the page shouldn't navigate away.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// Folders dropped from Finder/Explorer are walked recursively.
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

const setAll = (on: boolean) => {
  const visible: Record<string, boolean> = {};
  state.board?.layers.forEach((l) => (visible[l.id] = on));
  update({ visible });
};
$("show-all").addEventListener("click", () => setAll(true));
$("hide-all").addEventListener("click", () => setAll(false));

// viewer tabs (arrow keys move between them, per the tabs pattern)
const tabs = [...document.querySelectorAll<HTMLButtonElement>("#view-tabs [data-view]")];
tabs.forEach((b, i) => {
  b.addEventListener("click", () => {
    if (state.pickMode && b.dataset.view !== "2d") update({ pickMode: false });
    update({ view: b.dataset.view as "2d" | "3d" });
  });
  b.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
});

document.querySelectorAll<HTMLButtonElement>("#side-seg .seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#side-seg .seg-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    view2d.setSide(btn.dataset.side as "top" | "bottom");
  }),
);
$("fit-2d").addEventListener("click", () => view2d.fitBoard());
document.querySelectorAll<HTMLButtonElement>("#cam-seg .seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#cam-seg .seg-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    view3d.setCamera(btn.dataset.cam as "top" | "bottom" | "iso");
  }),
);

initSheet();
showView(state.view);
renderSteps();
syncPick();
stampIn(document.querySelector(".app")!, ".col > *");

api
  .config()
  .then((config) => {
    $("max-mb").textContent = String(config.max_upload_mb);
    if (!hasStoredXcs) {
      // server defaults, not saved: only the user's own changes are remembered
      state.xcsOpts = { ...state.xcsOpts, hole_tolerance: config.defaults.hole_tolerance_mm, mounting_diameter: config.xcs.mounting_hole_mm };
    }
    update({ config });
    initExportDefaults();
  })
  .catch((e) => update({ error: `Can't reach the server: ${(e as Error).message}` }));
