export type Side = "front" | "back";

export interface Poly {
  outer: [number, number][];
  holes: [number, number][][];
}

export interface LayerView {
  id: string;
  filename: string;
  format: "gerber" | "excellon";
  role: string;
  label: string;
  d: string;
  polys: Poly[];
  holes?: [number, number, number][];
  slots?: [number, number, number, number, number][];
}

export interface BoardView {
  session_id: string;
  name: string;
  board: {
    width: number;
    height: number;
    outline_d: string;
    body: Poly[];
    coats: { front: Poly[]; back: Poly[] };
    thickness: number;
  };
  layers: LayerView[];
  sides_present: Side[];
  ignored: string[];
  warnings: string[];
}

export interface XcsLayerSpec {
  key: string;
  name: string;
  color: string;
  process: "cut" | "engrave";
  group: "cut" | "etch";
}

export interface AppConfig {
  roles: { id: string; label: string }[];
  kinds: string[];
  defaults: { mirror_front: boolean; mirror_back: boolean; dpi: number; max_dpi: number; hole_tolerance_mm: number };
  max_upload_mb: number;
  board_thickness_mm: number;
  png_available: boolean;
  xcs: {
    bed: { w: number; h: number };
    layers: XcsLayerSpec[];
    max_offset_mm: number;
  };
}

export interface ExportOptions {
  sides: Side[];
  kinds: Record<string, boolean>;
  mirror_front: boolean;
  mirror_back: boolean;
  invert_copper: boolean;
  png: boolean;
  dpi: number;
  hole_tolerance: number;
}

/** A hole in a drill layer, by its index in `LayerView.holes`. */
export interface HoleRef {
  layer_id: string;
  index: number;
}

export interface XcsOpts {
  hidden: Record<Side, string[]>;
  offsets: { cut: [number, number]; etch: [number, number] };
  hole_tolerance: number;
  invert_copper: boolean;
}

/** A built file on the server. `url` is a plain GET that answers with Content-Disposition: attachment. */
export interface FileLink {
  name: string;
  size: number;
  url: string;
}

export interface XcsPreviewLayer {
  key: string;
  count: number;
  /** SVG path data in bed millimetres, before offsets. */
  d: string;
}

export interface XcsResult {
  bed: { w: number; h: number };
  sides: Partial<Record<Side, { layers: XcsPreviewLayer[]; file: FileLink | null }>>;
  zip: FileLink | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  config: () => fetch("/api/config").then((r) => json<AppConfig>(r)),

  upload(files: File[]) {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => json<BoardView>(r));
  },

  setRole: (sid: string, layerId: string, role: string) =>
    fetch(`/api/session/${sid}/layers/${layerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }).then((r) => json<BoardView>(r)),

  /** Preview of both xTool projects plus fresh download links. */
  xcs: (sid: string, opts: XcsOpts, mounting: HoleRef[]) =>
    post(`/api/session/${sid}/xcs`, { sides: ["front", "back"], ...opts, mounting }).then((r) => json<XcsResult>(r)),

  preview: (sid: string, opts: ExportOptions) =>
    post(`/api/session/${sid}/export/preview`, opts).then((r) => json<{ files: { name: string; svg: string }[] }>(r)),

  /** Builds the SVG/PNG zip on the server; download it through the returned link. */
  exportZip: (sid: string, opts: ExportOptions) => post(`/api/session/${sid}/export`, opts).then((r) => json<FileLink>(r)),
};
