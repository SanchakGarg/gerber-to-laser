// Small DOM helpers shared by every panel.

type Kid = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// 24×24 stroke icons, drawn in currentColor.
const ICONS = {
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.1 3.9M6.6 6.7A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5a9.6 9.6 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19.5h16"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 19.5h16"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  spark: '<path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5M5.3 5.3l3 3M15.7 15.7l3 3M18.7 5.3l-3 3M8.3 15.7l-3 3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  zoom: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M11 8v6M8 11h6"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = "") {
  const span = document.createElement("span");
  span.className = `icon ${cls}`.trim();
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtMm(v: number) {
  return (Math.round(v * 1000) / 1000).toFixed(2);
}

let toastTimer = 0;
export function toast(msg: string, error = false) {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.toggle("error", error);
  t.hidden = false;
  t.classList.remove("show");
  void t.offsetWidth; // restart the slide-in
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    t.classList.remove("show");
    window.setTimeout(() => (t.hidden = true), 300);
  }, 3200);
}
