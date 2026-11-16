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
  sides_present: ("front" | "back")[];
  ignored: string[];
  warnings: string[];
}

export interface AppConfig {
  roles: { id: string; label: string }[];
  kinds: string[];
  defaults: { mirror_front: boolean; mirror_back: boolean; dpi: number; max_dpi: number; hole_tolerance_mm: number };
  max_upload_mb: number;
  board_thickness_mm: number;
  png_available: boolean;
}

export interface ExportOptions {
  sides: ("front" | "back")[];
  kinds: Record<string, boolean>;
  mirror_front: boolean;
  mirror_back: boolean;
  invert_copper: boolean;
  png: boolean;
  dpi: number;
  hole_tolerance: number;
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

export const api = {
  config: () => fetch("/api/config").then((r) => json<AppConfig>(r)),

  upload(files: File[]) {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, (f as File & { relPath?: string }).name));
    return fetch("/api/upload", { method: "POST", body: fd }).then((r) => json<BoardView>(r));
  },

  setRole: (sid: string, layerId: string, role: string) =>
    fetch(`/api/session/${sid}/layers/${layerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }).then((r) => json<BoardView>(r)),

  preview: (sid: string, opts: ExportOptions) =>
    fetch(`/api/session/${sid}/export/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then((r) => json<{ files: { name: string; svg: string }[] }>(r)),

  async exportZip(sid: string, opts: ExportOptions): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(`/api/session/${sid}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
    if (!res.ok) await json(res);
    const cd = res.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? "laser.zip";
    return { blob: await res.blob(), filename };
  },
};

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
