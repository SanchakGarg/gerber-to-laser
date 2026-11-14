import type { BoardView, LayerView } from "./api";
import { paper, styleFor } from "./palette";
import { isVisible } from "./state";

const NS = "http://www.w3.org/2000/svg";

// Draw order seen from the top; reversed role priority for the bottom view.
const TOP_ORDER = [
  "other", "bottom_paste", "bottom_silk", "bottom_mask", "bottom_copper", "inner_copper",
  "top_copper", "top_mask", "top_silk", "top_paste", "drill", "outline",
];
const BOTTOM_ORDER = [
  "other", "top_paste", "top_silk", "top_mask", "top_copper", "inner_copper",
  "bottom_copper", "bottom_mask", "bottom_silk", "bottom_paste", "drill", "outline",
];

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class View2D {
  private host: HTMLElement;
  private readout: HTMLElement;
  private svg: SVGSVGElement | null = null;
  private flipG: SVGGElement | null = null;
  private groups = new Map<string, SVGGElement>();
  private vb = { x: 0, y: 0, w: 1, h: 1 };
  private side: "top" | "bottom" = "top";
  private board: BoardView | null = null;

  constructor(host: HTMLElement, readout: HTMLElement) {
    this.host = host;
    this.readout = readout;
    new ResizeObserver(() => this.applyViewBox()).observe(host);
  }

  setBoard(board: BoardView | null) {
    this.board = board;
    this.groups.clear();
    this.host.querySelector("svg")?.remove();
    this.host.querySelector(".empty")?.toggleAttribute("hidden", !!board);
    if (!board) return;

    const { width: w, height: h } = board.board;
    const svg = svgEl("svg", { class: "board2d", role: "img", "aria-label": `2D view of ${board.name}` });
    const flip = svgEl("g");
    // board substrate
    flip.append(svgEl("path", {
      d: board.board.outline_d, fill: paper.kraft, "fill-rule": "evenodd", opacity: 0.55,
    }));
    for (const l of board.layers) {
      const g = this.layerGroup(l);
      this.groups.set(l.id, g);
    }
    svg.append(flip);
    this.svg = svg;
    this.flipG = flip;
    this.host.prepend(svg);
    this.order();
    this.bindPanZoom(svg);
    this.fit(w, h);
    this.refreshVisibility();
  }

  private layerGroup(l: LayerView) {
    const st = styleFor(l.role);
    const g = svgEl("g", { "data-role": l.role });
    if (l.role === "drill") {
      for (const [x, y, d] of l.holes ?? []) {
        g.append(svgEl("circle", {
          cx: x, cy: y, r: d / 2, fill: paper.paper, stroke: paper.ink,
          "stroke-width": 1.2, "vector-effect": "non-scaling-stroke",
        }));
      }
      for (const [x1, y1, x2, y2, wd] of l.slots ?? []) {
        g.append(svgEl("line", {
          x1, y1, x2, y2, stroke: paper.ink, "stroke-width": wd, "stroke-linecap": "round",
        }));
        g.append(svgEl("line", {
          x1, y1, x2, y2, stroke: paper.paper, "stroke-width": Math.max(wd - 0.08, 0.01), "stroke-linecap": "round",
        }));
      }
    } else if (l.role === "outline") {
      g.append(svgEl("path", {
        d: this.board!.board.outline_d, fill: "none", stroke: paper.margin,
        "stroke-width": 1.6, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round",
      }));
    } else if (l.d) {
      g.append(svgEl("path", { d: l.d, fill: st.color, "fill-rule": "evenodd", opacity: st.opacity }));
    }
    return g;
  }

  private order() {
    if (!this.flipG || !this.board) return;
    const order = this.side === "top" ? TOP_ORDER : BOTTOM_ORDER;
    const layers = [...this.board.layers].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    for (const l of layers) {
      const g = this.groups.get(l.id);
      if (g) this.flipG.append(g);
    }
    const w = this.board.board.width;
    this.flipG.setAttribute("transform", this.side === "bottom" ? `translate(${w} 0) scale(-1 1)` : "");
  }

  setSide(side: "top" | "bottom") {
    this.side = side;
    this.order();
  }

  refreshVisibility() {
    for (const [id, g] of this.groups) g.style.display = isVisible(id) ? "" : "none";
  }

  fitBoard() {
    if (this.board) this.fit(this.board.board.width, this.board.board.height);
  }

  private fit(w: number, h: number) {
    const pad = Math.max(w, h) * 0.08 + 1;
    this.vb = { x: -pad, y: -pad, w: w + 2 * pad, h: h + 2 * pad };
    this.applyViewBox();
  }

  // Keep the logical viewBox but match the element's aspect ratio, so zoom math stays simple.
  private applyViewBox() {
    if (!this.svg) return;
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const aspect = r.width / r.height;
    let { x, y, w, h } = this.vb;
    if (w / h > aspect) {
      const nh = w / aspect;
      y -= (nh - h) / 2;
      h = nh;
    } else {
      const nw = h * aspect;
      x -= (nw - w) / 2;
      w = nw;
    }
    this.vb = { x, y, w, h };
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  }

  private toBoard(evt: { clientX: number; clientY: number }) {
    const r = this.svg!.getBoundingClientRect();
    return {
      x: this.vb.x + ((evt.clientX - r.left) / r.width) * this.vb.w,
      y: this.vb.y + ((evt.clientY - r.top) / r.height) * this.vb.h,
    };
  }

  private bindPanZoom(svg: SVGSVGElement) {
    let drag: { x: number; y: number; vx: number; vy: number } | null = null;

    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = this.toBoard(e);
      const k = Math.exp(e.deltaY * 0.0015);
      const { x, y, w, h } = this.vb;
      const nw = Math.min(Math.max(w * k, 0.5), 5000);
      const s = nw / w;
      this.vb = { x: p.x - (p.x - x) * s, y: p.y - (p.y - y) * s, w: w * s, h: h * s };
      svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
    }, { passive: false });

    svg.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add("dragging");
    });
    svg.addEventListener("pointermove", (e) => {
      const p = this.toBoard(e);
      if (this.board) {
        const bx = this.side === "bottom" ? this.board.board.width - p.x : p.x;
        this.readout.textContent = `x ${bx.toFixed(2)} mm · y ${p.y.toFixed(2)} mm`;
      }
      if (!drag) return;
      const r = svg.getBoundingClientRect();
      this.vb.x = drag.vx - ((e.clientX - drag.x) / r.width) * this.vb.w;
      this.vb.y = drag.vy - ((e.clientY - drag.y) / r.height) * this.vb.h;
      svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
    });
    const end = () => {
      drag = null;
      svg.classList.remove("dragging");
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("pointerleave", () => (this.readout.textContent = ""));
    svg.addEventListener("dblclick", () => this.fitBoard());
  }
}
