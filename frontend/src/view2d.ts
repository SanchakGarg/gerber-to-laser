import type { BoardView, HoleRef, LayerView } from "./api";
import { ink, styleFor } from "./palette";
import { isVisible } from "./state";
import { svgEl } from "./ui";

// Draw order seen from the top; reversed role priority for the bottom view.
const TOP_ORDER = [
  "other", "bottom_paste", "bottom_silk", "bottom_mask", "bottom_copper", "inner_copper",
  "top_copper", "top_mask", "top_silk", "top_paste", "drill", "outline",
];
const BOTTOM_ORDER = [
  "other", "top_paste", "top_silk", "top_mask", "top_copper", "inner_copper",
  "bottom_copper", "bottom_mask", "bottom_silk", "bottom_paste", "drill", "outline",
];

const CLICK_SLOP_PX = 4;   // a press that moves less than this is a click, not a pan
const HIT_SLOP_PX = 9;     // tiny holes are clickable within this many screen pixels

interface Hole {
  ref: HoleRef;
  x: number;
  y: number;
  d: number;
  el: SVGCircleElement;
}

export class View2D {
  /** Called with the hole under the pointer when the user clicks in pick mode. */
  onPick: ((ref: HoleRef) => void) | null = null;

  private host: HTMLElement;
  private readout: HTMLElement;
  private svg: SVGSVGElement | null = null;
  private flipG: SVGGElement | null = null;
  private mountG: SVGGElement | null = null;
  private groups = new Map<string, SVGGElement>();
  private holes: Hole[] = [];
  private vb = { x: 0, y: 0, w: 1, h: 1 };
  private side: "top" | "bottom" = "top";
  private board: BoardView | null = null;
  private picking = false;
  private hover: Hole | null = null;
  private mounting: HoleRef[] = [];
  private mountD = 2;

  constructor(host: HTMLElement, readout: HTMLElement) {
    this.host = host;
    this.readout = readout;
    new ResizeObserver(() => this.applyViewBox()).observe(host);
  }

  setBoard(board: BoardView | null) {
    this.board = board;
    this.groups.clear();
    this.holes = [];
    this.hover = null;
    this.host.querySelector("svg.board2d")?.remove();
    this.host.querySelector(".empty")?.toggleAttribute("hidden", !!board);
    if (!board) return;

    const { width: w, height: h } = board.board;
    const svg = svgEl("svg", { class: "board2d", role: "img", "aria-label": `2D view of ${board.name}` });
    const flip = svgEl("g");
    flip.append(svgEl("path", {
      class: "substrate", d: board.board.outline_d, fill: ink.board, "fill-rule": "evenodd",
    }));
    for (const l of board.layers) this.groups.set(l.id, this.layerGroup(l));
    this.mountG = svgEl("g", { class: "mount-marks" });
    svg.append(flip);
    this.svg = svg;
    this.flipG = flip;
    this.host.prepend(svg);
    this.order();
    this.bindPanZoom(svg);
    this.fit(w, h);
    this.refreshVisibility();
    this.setPickMode(this.picking);
    this.drawMounting();
  }

  private layerGroup(l: LayerView) {
    const st = styleFor(l.role);
    const g = svgEl("g", { class: `layer role-${l.role}`, "data-role": l.role });
    if (l.role === "drill") {
      g.classList.add("drill");
      (l.holes ?? []).forEach(([x, y, d], index) => {
        const el = svgEl("circle", { class: "hole", cx: x, cy: y, r: d / 2, "vector-effect": "non-scaling-stroke" });
        g.append(el);
        this.holes.push({ ref: { layer_id: l.id, index }, x, y, d, el });
      });
      for (const [x1, y1, x2, y2, wd] of l.slots ?? []) {
        g.append(svgEl("line", { class: "slot-edge", x1, y1, x2, y2, "stroke-width": wd, "stroke-linecap": "round" }));
        g.append(svgEl("line", {
          class: "slot-core", x1, y1, x2, y2, "stroke-width": Math.max(wd - 0.08, 0.01), "stroke-linecap": "round",
        }));
      }
    } else if (l.role === "outline") {
      g.append(svgEl("path", {
        class: "outline", d: this.board!.board.outline_d, fill: "none",
        "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round",
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
    if (this.mountG) this.flipG.append(this.mountG);
    const w = this.board.board.width;
    this.flipG.setAttribute("transform", this.side === "bottom" ? `translate(${w} 0) scale(-1 1)` : "");
  }

  setSide(side: "top" | "bottom") {
    this.side = side;
    this.order();
  }

  refreshVisibility() {
    for (const [id, g] of this.groups) g.classList.toggle("is-hidden", !isVisible(id));
  }

  // ---------- mounting holes ----------

  setPickMode(on: boolean) {
    this.picking = on;
    this.svg?.classList.toggle("picking", on);
    if (!on) this.setHover(null);
  }

  setMounting(refs: HoleRef[], diameter: number) {
    this.mounting = refs;
    this.mountD = diameter;
    this.drawMounting();
  }

  private drawMounting() {
    if (!this.mountG) return;
    const picked = new Set(this.mounting.map((r) => `${r.layer_id}:${r.index}`));
    // keep existing marks (so only new ones pop in); redraw all if the jig size changed
    const sizeKey = String(this.mountD);
    if (this.mountG.dataset.d !== sizeKey) {
      this.mountG.replaceChildren();
      this.mountG.dataset.d = sizeKey;
    }
    const existing = new Map([...this.mountG.children].map((m) => [(m as SVGGElement).dataset.key!, m]));
    for (const hole of this.holes) {
      const key = `${hole.ref.layer_id}:${hole.ref.index}`;
      const on = picked.has(key);
      hole.el.classList.toggle("picked", on);
      const mark = existing.get(key);
      if (!on) {
        mark?.remove();
        continue;
      }
      if (mark) continue;
      // registration mark: jig-hole circle + crosshair, centred on the hole
      const r = this.mountD / 2;
      const arm = Math.max(r, hole.d / 2) * 1.7;
      const g = svgEl("g", { class: "mark", transform: `translate(${hole.x} ${hole.y})` });
      g.dataset.key = key;
      g.append(
        svgEl("circle", { class: "mark-ring", r: Math.max(r, hole.d / 2 + 0.15), "vector-effect": "non-scaling-stroke" }),
        svgEl("circle", { class: "mark-jig", r, "vector-effect": "non-scaling-stroke" }),
        svgEl("path", { class: "mark-cross", d: `M ${-arm} 0 H ${arm} M 0 ${-arm} V ${arm}`, "vector-effect": "non-scaling-stroke" }),
      );
      this.mountG.append(g);
    }
  }

  private setHover(hole: Hole | null) {
    if (this.hover === hole) return;
    this.hover?.el.classList.remove("hover");
    this.hover = hole;
    hole?.el.classList.add("hover");
    this.svg?.classList.toggle("over-hole", !!hole);
  }

  private holeAt(evt: { clientX: number; clientY: number }): Hole | null {
    if (!this.svg || !this.board) return null;
    const p = this.toBoard(evt);
    const bx = this.side === "bottom" ? this.board.board.width - p.x : p.x;
    const r = this.svg.getBoundingClientRect();
    const slop = (HIT_SLOP_PX / r.width) * this.vb.w;
    let best: Hole | null = null;
    let bestDist = Infinity;
    for (const hole of this.holes) {
      const dist = Math.hypot(hole.x - bx, hole.y - p.y);
      if (dist <= Math.max(hole.d / 2, slop) && dist < bestDist) {
        best = hole;
        bestDist = dist;
      }
    }
    return best;
  }

  // ---------- view box ----------

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
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;

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
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.vb.x, vy: this.vb.y, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      const p = this.toBoard(e);
      if (this.picking && !drag) this.setHover(this.holeAt(e));
      this.updateReadout(p);
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < CLICK_SLOP_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        svg.classList.add("dragging");
        this.setHover(null);
      }
      const r = svg.getBoundingClientRect();
      this.vb.x = drag.vx - ((e.clientX - drag.x) / r.width) * this.vb.w;
      this.vb.y = drag.vy - ((e.clientY - drag.y) / r.height) * this.vb.h;
      svg.setAttribute("viewBox", `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
    });
    svg.addEventListener("pointerup", (e) => {
      const click = drag && !drag.moved;
      drag = null;
      svg.classList.remove("dragging");
      if (click && this.picking) {
        const hole = this.holeAt(e);
        if (hole) this.onPick?.(hole.ref);
      }
    });
    svg.addEventListener("pointercancel", () => {
      drag = null;
      svg.classList.remove("dragging");
    });
    svg.addEventListener("pointerleave", () => {
      this.readout.textContent = "";
      this.setHover(null);
    });
    svg.addEventListener("dblclick", () => {
      if (!this.picking) this.fitBoard();
    });
  }

  private updateReadout(p: { x: number; y: number }) {
    if (!this.board) return;
    if (this.picking && this.hover) {
      const { d, x, y } = this.hover;
      this.readout.textContent = `hole Ø ${d.toFixed(2)} mm · x ${x.toFixed(2)} · y ${y.toFixed(2)}`;
      return;
    }
    const bx = this.side === "bottom" ? this.board.board.width - p.x : p.x;
    this.readout.textContent = `x ${bx.toFixed(2)} mm · y ${p.y.toFixed(2)} mm`;
  }
}
