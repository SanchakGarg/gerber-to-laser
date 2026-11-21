import type { BoardView, HoleRef, LayerView } from "./api";
import { ink, styleFor } from "./palette";
import { holePairs, pickedHoles } from "./measure";
import { isVisible } from "./state";
import { fmtMm, svgEl } from "./ui";

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
const DIM_FONT_PX = 11;    // dimension labels keep this on-screen size at any zoom
const DIM_HALO_PX = 3.5;

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
  /** Dimension lines: board coordinates, inside the group that mirrors for the bottom view. */
  private dimLinesG: SVGGElement | null = null;
  /** Dimension labels: outside the mirror so text never reads backwards; positions mirrored by hand. */
  private dimTextG: SVGGElement | null = null;
  private groups = new Map<string, SVGGElement>();
  private holes: Hole[] = [];
  private vb = { x: 0, y: 0, w: 1, h: 1 };
  private side: "top" | "bottom" = "top";
  private board: BoardView | null = null;
  private picking = false;
  private hover: Hole | null = null;
  private mounting: HoleRef[] = [];
  private showDims = true;

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
    this.dimLinesG = svgEl("g", { class: "dim-lines" });
    this.dimTextG = svgEl("g", { class: "dim-text" });
    svg.append(flip, this.dimTextG);
    this.svg = svg;
    this.flipG = flip;
    this.host.prepend(svg);
    this.order();
    this.bindPanZoom(svg);
    this.fit(w, h);
    this.refreshVisibility();
    this.setPickMode(this.picking);
    this.drawMounting();
    this.drawDims();
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
    if (this.dimLinesG) this.flipG.append(this.dimLinesG);
    if (this.mountG) this.flipG.append(this.mountG);
    const w = this.board.board.width;
    this.flipG.setAttribute("transform", this.side === "bottom" ? `translate(${w} 0) scale(-1 1)` : "");
  }

  setSide(side: "top" | "bottom") {
    this.side = side;
    this.order();
    this.drawDims();
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

  setMounting(refs: HoleRef[]) {
    this.mounting = refs;
    this.drawMounting();
    this.drawDims();
  }

  setShowDims(on: boolean) {
    if (this.showDims === on) return;
    this.showDims = on;
    this.drawDims();
  }

  /** Ø label per picked hole, numbered in pick order, and a centre-to-centre line + distance per pair. */
  private drawDims() {
    if (!this.dimLinesG || !this.dimTextG || !this.board) return;
    this.dimLinesG.replaceChildren();
    this.dimTextG.replaceChildren();
    if (!this.showDims) return;
    const holes = pickedHoles(this.board, this.mounting);
    if (!holes.length) return;
    const w = this.board.board.width;
    const sx = (x: number) => (this.side === "bottom" ? w - x : x);
    const text = (cls: string, x: number, y: number, attrs: Record<string, string | number>, label: string) => {
      const t = svgEl("text", { class: cls, x, y, ...attrs });
      t.textContent = label;
      this.dimTextG!.append(t);
      return t;
    };

    const pairs = holePairs(holes);
    // labels sit at the middle of their line, unless that collides with one already placed
    // (a rectangle's diagonals share a midpoint): then they slide along their own line
    const px = this.host.getBoundingClientRect().width;
    const near = px ? (DIM_FONT_PX * 4 * this.vb.w) / px : 0;
    const placed: [number, number][] = [];
    for (const p of pairs) {
      this.dimLinesG.append(svgEl("line", {
        class: "dim-line", x1: p.a.x, y1: p.a.y, x2: p.b.x, y2: p.b.y, "vector-effect": "non-scaling-stroke",
      }));
      const at = (t: number): [number, number] => [sx(p.a.x + p.dx * t), p.a.y + p.dy * t];
      let [mx, my] = at(0.5);
      for (const t of [0.5, 0.3, 0.7]) {
        [mx, my] = at(t);
        if (!placed.some(([qx, qy]) => Math.hypot(qx - mx, qy - my) < near)) break;
      }
      placed.push([mx, my]);
      text("dim-dist", mx, my, { "text-anchor": "middle", dy: "-0.55em" }, `${fmtMm(p.dist)} mm`);
      // a lone diagonal pair also gets its X/Y split, which is what a jig is measured in
      if (pairs.length === 1 && Math.abs(p.dx) >= 0.005 && Math.abs(p.dy) >= 0.005) {
        text("dim-sub", mx, my, { "text-anchor": "middle", dy: "1.25em" },
          `Δx ${fmtMm(Math.abs(p.dx))} · Δy ${fmtMm(Math.abs(p.dy))}`);
      }
    }
    for (const hole of holes) {
      // just outside the mark's ring, up and to the right (on screen)
      const r = (hole.d / 2 + 0.15) * 0.75;
      const t = text("dim-hole", sx(hole.x) + r, hole.y - r, { dx: "0.3em", dy: "-0.25em" }, "");
      const num = svgEl("tspan", { class: "dim-num" });
      num.textContent = `#${hole.n}`;
      t.append(num, ` Ø${fmtMm(hole.d)}`);
    }
    this.scaleLabels();
  }

  /** Text and halo are sized in board units: rescale them so they stay the same on screen. */
  private scaleLabels() {
    if (!this.dimTextG) return;
    const px = this.host.getBoundingClientRect().width;
    if (!px) return;
    const k = this.vb.w / px;
    this.dimTextG.style.fontSize = `${DIM_FONT_PX * k}px`;
    this.dimTextG.style.strokeWidth = `${DIM_HALO_PX * k}px`;
  }

  private drawMounting() {
    if (!this.mountG) return;
    const picked = new Set(this.mounting.map((r) => `${r.layer_id}:${r.index}`));
    // keep existing marks, so only new ones pop in
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
      // registration mark: ring + crosshair, centred on the hole
      const arm = (hole.d / 2) * 1.7;
      const g = svgEl("g", { class: "mark", transform: `translate(${hole.x} ${hole.y})` });
      g.dataset.key = key;
      g.append(
        svgEl("circle", { class: "mark-ring", r: hole.d / 2 + 0.15, "vector-effect": "non-scaling-stroke" }),
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
    this.scaleLabels();
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
      this.scaleLabels();
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
      let msg = `hole Ø ${d.toFixed(2)} mm · x ${x.toFixed(2)} · y ${y.toFixed(2)}`;
      // while choosing the next hole, say how far it is from the last one picked
      const picked = pickedHoles(this.board, this.mounting);
      const last = picked[picked.length - 1];
      if (last && !picked.some((p) => p.ref.layer_id === this.hover!.ref.layer_id && p.ref.index === this.hover!.ref.index)) {
        msg += ` · ${fmtMm(Math.hypot(x - last.x, y - last.y))} mm from #${last.n}`;
      }
      this.readout.textContent = msg;
      return;
    }
    const bx = this.side === "bottom" ? this.board.board.width - p.x : p.x;
    this.readout.textContent = `x ${bx.toFixed(2)} mm · y ${p.y.toFixed(2)} mm`;
  }
}
