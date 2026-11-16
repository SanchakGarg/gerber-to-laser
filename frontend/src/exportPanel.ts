import { api, download } from "./api";
import { state, update } from "./state";

const KIND_LABELS: Record<string, [string, string]> = {
  copper: ["Copper", "negative"],
  silk: ["Silkscreen", ""],
  mask: ["Solder mask", "openings"],
  cut: ["Cut outline", ""],
  drill: ["Drill", "hole outlines"],
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

function check(label: string, checked: boolean, onChange: (v: boolean) => void, hint = "", disabled = false) {
  const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
  cb.checked = checked;
  cb.disabled = disabled;
  cb.addEventListener("change", () => onChange(cb.checked));
  return h("label", { class: "check" }, cb, label, ...(hint ? [h("small", {}, hint)] : []));
}

function setOpts(patch: Partial<typeof state.exportOpts>) {
  update({ exportOpts: { ...state.exportOpts, ...patch } });
}

export function initExportDefaults() {
  const b = state.board;
  const c = state.config;
  const sides = b?.sides_present.length ? b.sides_present : (["front", "back"] as ("front" | "back")[]);
  setOpts({
    sides,
    mirror_front: c?.defaults.mirror_front ?? false,
    mirror_back: c?.defaults.mirror_back ?? true,
    dpi: c?.defaults.dpi ?? 1000,
    hole_tolerance: c?.defaults.hole_tolerance_mm ?? 0.2,
  });
}

export function renderExportPanel() {
  const host = document.getElementById("export-panel")!;
  const o = state.exportOpts;
  const pngOk = state.config?.png_available ?? false;

  // sides
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Sides to export" });
  const choices: [string, ("front" | "back")[]][] = [["Front", ["front"]], ["Back", ["back"]], ["Both", ["front", "back"]]];
  for (const [label, sides] of choices) {
    const active = sides.length === o.sides.length && sides.every((s) => o.sides.includes(s));
    const btn = h("button", { type: "button", class: `seg-btn${active ? " active" : ""}`, "aria-pressed": String(active) }, label);
    btn.addEventListener("click", () => setOpts({ sides }));
    seg.append(btn);
  }

  const kinds = h("div", { class: "kinds" });
  for (const k of state.config?.kinds ?? Object.keys(KIND_LABELS)) {
    const [label, hint] = KIND_LABELS[k] ?? [k, ""];
    kinds.append(check(label, o.kinds[k] !== false, (v) => setOpts({ kinds: { ...o.kinds, [k]: v } }), hint));
  }

  const dpi = h("input", { type: "number", min: "50", max: String(state.config?.defaults.max_dpi ?? 2400), step: "50", "aria-label": "PNG DPI" }) as HTMLInputElement;
  dpi.value = String(o.dpi);
  dpi.disabled = !o.png || !pngOk;
  dpi.addEventListener("change", () => setOpts({ dpi: Math.max(1, parseInt(dpi.value, 10) || 1000) }));

  const tol = h("input", { type: "number", min: "-2", max: "2", step: "0.05", "aria-label": "Hole tolerance in mm" }) as HTMLInputElement;
  tol.value = String(o.hole_tolerance);
  tol.disabled = o.kinds.drill === false;
  tol.addEventListener("change", () => {
    const v = parseFloat(tol.value);
    setOpts({ hole_tolerance: Number.isFinite(v) ? Math.min(2, Math.max(-2, v)) : 0 });
  });

  const previewBtn = h("button", { type: "button", class: "btn" }, "Preview files") as HTMLButtonElement;
  const zipBtn = h("button", { type: "button", class: "btn btn-primary" }, "Download ZIP") as HTMLButtonElement;
  const nothing = !o.sides.length || !Object.values(o.kinds).some(Boolean);
  previewBtn.disabled = zipBtn.disabled = nothing || !!state.busy;
  previewBtn.addEventListener("click", openPreview);
  zipBtn.addEventListener("click", downloadZip);

  host.replaceChildren(
    h("div", { class: "field" }, h("div", { class: "field-label" }, "Sides"), seg),
    h("div", { class: "field" }, h("div", { class: "field-label" }, "Files per side"), kinds),
    h("div", { class: "field" },
      h("div", { class: "field-label" }, "Mirror"),
      h("div", { class: "row" },
        check("Front", o.mirror_front, (v) => setOpts({ mirror_front: v })),
        check("Back", o.mirror_back, (v) => setOpts({ mirror_back: v }), "seen through board"),
      ),
    ),
    h("div", { class: "field" },
      h("div", { class: "field-label" }, "Options"),
      check("Invert copper", o.invert_copper, (v) => setOpts({ invert_copper: v }), "positive traces"),
      h("div", { class: "row" },
        check("Also PNG", o.png && pngOk, (v) => setOpts({ png: v }), pngOk ? "" : "no rasterizer", !pngOk),
        h("label", { class: "check" }, "DPI", dpi),
      ),
      h("label", { class: "check" }, "Hole tolerance", tol, "mm", h("small", {}, "drill holes cut this much smaller")),
    ),
    h("div", { class: "actions" }, previewBtn, zipBtn),
  );
}

async function downloadZip() {
  const b = state.board;
  if (!b) return;
  update({ busy: "Exporting…", error: null });
  try {
    const { blob, filename } = await api.exportZip(b.session_id, state.exportOpts);
    download(blob, filename);
    toast(`Saved ${filename}`);
  } catch (e) {
    console.error(e);
    update({ error: (e as Error).message });
  } finally {
    update({ busy: null });
  }
}

let lastFocus: HTMLElement | null = null;

async function openPreview() {
  const b = state.board;
  if (!b) return;
  update({ busy: "Rendering preview…", error: null });
  try {
    const { files } = await api.preview(b.session_id, state.exportOpts);
    const thumbs = document.getElementById("thumbs")!;
    thumbs.replaceChildren();
    if (!files.length) thumbs.append(h("p", {}, "Nothing to export with these options."));
    for (const f of files) {
      const blob = new Blob([f.svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = h("img", { src: url, alt: f.name });
      const mirrored = f.name.includes("_front_") ? state.exportOpts.mirror_front : state.exportOpts.mirror_back;
      const dl = h("button", { type: "button", class: "btn btn-small" }, "SVG");
      dl.addEventListener("click", () => download(blob, f.name));
      thumbs.append(h("div", { class: "thumb" },
        h("div", { class: "thumb-img" }, img),
        h("div", { class: "thumb-name" }, f.name),
        h("div", { class: "thumb-row" },
          h("span", { class: `badge${mirrored ? " mirror" : ""}` }, mirrored ? "mirrored" : "as seen from top"),
          dl),
      ));
    }
    const sheet = document.getElementById("sheet")!;
    lastFocus = document.activeElement as HTMLElement;
    sheet.hidden = false;
    (sheet.querySelector("#sheet-zip") as HTMLButtonElement).focus();
  } catch (e) {
    console.error(e);
    update({ error: (e as Error).message });
  } finally {
    update({ busy: null });
  }
}

export function initSheet() {
  const sheet = document.getElementById("sheet")!;
  const close = () => {
    sheet.hidden = true;
    document.querySelectorAll<HTMLImageElement>("#thumbs img").forEach((i) => URL.revokeObjectURL(i.src));
    lastFocus?.focus();
  };
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) close();
  });
  document.getElementById("sheet-zip")!.addEventListener("click", downloadZip);
}

let toastTimer = 0;
export function toast(msg: string, error = false) {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}
