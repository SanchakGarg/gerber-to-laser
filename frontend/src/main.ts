import "./styles/notebook.css";
import { api } from "./api";
import { initExportDefaults, initSheet, renderExportPanel } from "./exportPanel";
import { renderBoardMeta, renderLayerList, renderNotes } from "./sidebar";
import { defaultVisible, state, subscribe, update } from "./state";
import { View2D } from "./view2d";
import { View3D } from "./view3d";

const view2d = new View2D(document.getElementById("view2d")!, document.getElementById("readout")!);
const view3d = new View3D(document.getElementById("view3d")!);

// ---------- state → UI ----------

subscribe((s, changed) => {
  if (changed.has("board")) {
    view2d.setBoard(s.board);
    view3d.setBoard(s.board);
    renderBoardMeta();
    document.getElementById("layers-card")!.hidden = !s.board;
    document.getElementById("export-card")!.hidden = !s.board;
  }
  if (changed.has("board") || changed.has("visible") || changed.has("config")) {
    renderLayerList(changeRole);
    view2d.refreshVisibility();
    view3d.refreshVisibility();
  }
  if (changed.has("board") || changed.has("error")) renderNotes();
  if (changed.has("exportOpts") || changed.has("board") || changed.has("busy") || changed.has("config")) renderExportPanel();
  if (changed.has("busy")) showBusy(s.busy);
});

function showBusy(msg: string | null) {
  document.querySelectorAll(".busy-overlay").forEach((e) => e.remove());
  if (!msg) return;
  for (const id of ["view2d", "view3d"]) {
    const o = document.createElement("div");
    o.className = "busy-overlay";
    o.innerHTML = `<div><div class="pencil-spin"></div></div>`;
    o.firstElementChild!.append(msg);
    document.getElementById(id)!.append(o);
  }
}

// ---------- actions ----------

function applyBoard(board: NonNullable<typeof state.board>, keepVisibility = false) {
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
    applyBoard(board);
    initExportDefaults();
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
    const visible = { ...state.visible, [layerId]: defaultVisible(role) };
    update({ visible });
    applyBoard(board, true);
  } catch (e) {
    console.error(e);
    update({ error: (e as Error).message });
    renderLayerList(changeRole); // revert the select
  } finally {
    update({ busy: null });
  }
}

// ---------- wiring ----------

const input = document.getElementById("file-input") as HTMLInputElement;
input.addEventListener("change", () => {
  handleFiles([...(input.files ?? [])]);
  input.value = "";
});

const drop = document.getElementById("drop")!;
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
document.getElementById("show-all")!.addEventListener("click", () => setAll(true));
document.getElementById("hide-all")!.addEventListener("click", () => setAll(false));

document.querySelectorAll<HTMLButtonElement>(".pane-2d .seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pane-2d .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    view2d.setSide(btn.dataset.side as "top" | "bottom");
  }),
);
document.getElementById("fit-2d")!.addEventListener("click", () => view2d.fitBoard());
document.querySelectorAll<HTMLButtonElement>(".pane-3d .seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => view3d.setCamera(btn.dataset.cam as "top" | "bottom" | "iso")),
);

initSheet();

api
  .config()
  .then((config) => {
    document.getElementById("max-mb")!.textContent = String(config.max_upload_mb);
    update({ config });
    initExportDefaults();
  })
  .catch((e) => update({ error: `Can't reach the server: ${(e as Error).message}` }));
