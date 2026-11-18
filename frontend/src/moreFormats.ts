// "More formats": the SVG (+PNG) zip, one file per layer kind and side, tucked under the XCS panel.
import { api, type ExportOptions, type FileLink, type Side } from "./api";
import { burst } from "./motion";
import { state, update } from "./state";
import { fmtBytes, h, icon, toast } from "./ui";

const KIND_LABELS: Record<string, [string, string]> = {
  copper: ["Copper", "negative"],
  silk: ["Silkscreen", ""],
  mask: ["Solder mask", "openings"],
  cut: ["Cut outline", ""],
  drill: ["Drill", "hole outlines"],
};

let link: FileLink | null = null;
let building = false;

function check(label: string, checked: boolean, onChange: (v: boolean) => void, hint = "", disabled = false) {
  const cb = h("input", { type: "checkbox" });
  cb.checked = checked;
  cb.disabled = disabled;
  cb.addEventListener("change", () => onChange(cb.checked));
  return h("label", { class: "check" }, cb, h("span", { class: "box", "aria-hidden": "true" }), label,
    hint ? h("small", {}, hint) : null);
}

function setOpts(patch: Partial<ExportOptions>) {
  link = null; // options changed: the built zip no longer matches
  update({ exportOpts: { ...state.exportOpts, ...patch } });
}

export function initExportDefaults() {
  const b = state.board;
  const c = state.config;
  const sides = b?.sides_present.length ? b.sides_present : (["front", "back"] as Side[]);
  setOpts({
    sides,
    mirror_front: c?.defaults.mirror_front ?? false,
    mirror_back: c?.defaults.mirror_back ?? true,
    dpi: c?.defaults.dpi ?? 1000,
    hole_tolerance: c?.defaults.hole_tolerance_mm ?? 0.2,
  });
}

export function resetMoreFormats() {
  link = null;
}

export function renderMoreFormats() {
  const host = document.getElementById("more-formats");
  if (!host) return;
  const o = state.exportOpts;
  const pngOk = state.config?.png_available ?? false;

  const seg = h("div", { class: "seg", role: "group", "aria-label": "Sides to export" });
  const choices: [string, Side[]][] = [["Front", ["front"]], ["Back", ["back"]], ["Both", ["front", "back"]]];
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

  const dpi = h("input", { type: "number", min: 50, max: state.config?.defaults.max_dpi ?? 2400, step: 50, "aria-label": "PNG DPI" });
  dpi.value = String(o.dpi);
  dpi.disabled = !o.png || !pngOk;
  dpi.addEventListener("change", () => setOpts({ dpi: Math.max(1, parseInt(dpi.value, 10) || 1000) }));

  const tol = h("input", { type: "number", min: -2, max: 2, step: 0.05, "aria-label": "Hole tolerance in mm" });
  tol.value = String(o.hole_tolerance);
  tol.disabled = o.kinds.drill === false;
  tol.addEventListener("change", () => {
    const v = parseFloat(tol.value);
    setOpts({ hole_tolerance: Number.isFinite(v) ? Math.min(2, Math.max(-2, v)) : 0 });
  });

  const nothing = !o.sides.length || !Object.values(o.kinds).some(Boolean);
  const previewBtn = h("button", { type: "button", class: "btn btn-small" }, "Preview");
  const buildBtn = h("button", { type: "button", class: "btn btn-small btn-primary" }, building ? "Building…" : "Build zip");
  previewBtn.disabled = buildBtn.disabled = nothing || building || !state.board;
  previewBtn.addEventListener("click", openPreview);
  buildBtn.addEventListener("click", buildZip);

  const actions = h("div", { class: "actions" }, previewBtn, buildBtn);
  if (link) {
    const a = h("a", { class: "dl dl-svg", href: link.url, download: link.name },
      h("span", { class: "dl-icon" }, icon("download")),
      h("span", { class: "dl-name" }, "SVG", h("small", {}, ".zip")),
      h("span", { class: "dl-meta" }, `${link.name} · ${fmtBytes(link.size)}`),
    );
    a.addEventListener("click", (e) => {
      burst(e.clientX, e.clientY, 18);
      toast(`Saving ${a.download}`);
    });
    actions.append(a);
  }

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
        h("label", { class: "inline-field" }, "DPI", dpi),
      ),
      h("label", { class: "inline-field" }, "Holes cut", tol, "mm smaller"),
    ),
    actions,
  );
}

async function buildZip() {
  const b = state.board;
  if (!b) return;
  building = true;
  renderMoreFormats();
  try {
    link = await api.exportZip(b.session_id, state.exportOpts);
    toast("SVG zip is ready: click it to save");
  } catch (e) {
    console.error(e);
    link = null;
    toast((e as Error).message, true);
  } finally {
    building = false;
    renderMoreFormats();
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
      const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(f.svg)}`;
      const mirrored = f.name.includes("_front_") ? state.exportOpts.mirror_front : state.exportOpts.mirror_back;
      thumbs.append(h("div", { class: "thumb" },
        h("div", { class: "thumb-img" }, h("img", { src, alt: f.name })),
        h("div", { class: "thumb-name" }, f.name),
        h("span", { class: `badge${mirrored ? " mirror" : ""}` }, mirrored ? "mirrored" : "as seen from top"),
      ));
    }
    const sheet = document.getElementById("sheet")!;
    lastFocus = document.activeElement as HTMLElement;
    sheet.hidden = false;
    sheet.querySelector<HTMLButtonElement>("[data-close]:not(.sheet-backdrop)")?.focus();
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
    lastFocus?.focus();
  };
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) close();
  });
}
