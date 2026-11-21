import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BoardView, Poly } from "./api";
import { ink, styleFor } from "./palette";
import { isVisible } from "./state";

const CU = 0.035; // copper thickness, mm
const MASK = 0.02;
const SILK = 0.012;

// Toon ramp: three flat tones, like a three-pass riso print.
function toonRamp() {
  const t = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class View3D {
  private host: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);
  private controls: OrbitControls | null = null;
  private root = new THREE.Group();
  private byLayer = new Map<string, THREE.Object3D[]>();
  private coats: { front: THREE.Object3D | null; back: THREE.Object3D | null } = { front: null, back: null };
  private board: BoardView | null = null;
  private ramp = toonRamp();
  private dims = { w: 50, h: 50 };

  constructor(host: HTMLElement) {
    this.host = host;
    this.scene.background = new THREE.Color(ink.paper);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfb4, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-40, 120, 60);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(40, -80, -60);
    this.scene.add(fill);
    // Board lies in world XZ; board +Z (top side) faces world +Y.
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);
    new ResizeObserver(() => this.resize()).observe(host);
  }

  private ensureRenderer() {
    if (this.renderer) return true;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      this.host.querySelector(".empty p:last-child")!.textContent = "WebGL isn't available in this browser.";
      return false;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.host.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());
    this.resize();
    return true;
  }

  /** Rebuilds the materials in the current theme's inks, keeping the camera. */
  restyle() {
    this.scene.background = new THREE.Color(ink.paper);
    if (this.board) this.setBoard(this.board, true);
    else this.render();
  }

  setBoard(board: BoardView | null, keepCamera = false) {
    this.board = board;
    this.clear();
    this.host.querySelector(".empty")?.toggleAttribute("hidden", !!board);
    if (!board || !this.ensureRenderer()) return;

    const { width: w, height: h, thickness: t } = board.board;
    this.dims = { w, h };
    const toShape = (p: Poly) => {
      const s = new THREE.Shape(p.outer.map(([x, y]) => new THREE.Vector2(x - w / 2, h / 2 - y)));
      for (const hole of p.holes) s.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x - w / 2, h / 2 - y))));
      return s;
    };
    const slab = (polys: Poly[], z: number, depth: number, mat: THREE.Material, edges = false) => {
      const good = polys
        .filter((p) => p.outer.length >= 3)
        .map((p) => ({ outer: p.outer, holes: p.holes.filter((hl) => hl.length >= 3) }));
      if (!good.length) return null;
      let geo: THREE.ExtrudeGeometry;
      try {
        geo = new THREE.ExtrudeGeometry(good.map(toShape), { depth, bevelEnabled: false, curveSegments: 1 });
      } catch (err) {
        console.warn("3D: skipped a layer that could not be triangulated", err);
        return null;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = z;
      const g = new THREE.Group();
      g.add(mesh);
      if (edges) {
        const lines = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo, 25),
          new THREE.LineBasicMaterial({ color: ink.ink, transparent: true, opacity: 0.85 }),
        );
        lines.position.z = z;
        g.add(lines);
      }
      this.root.add(g);
      return g;
    };
    const toon = (color: string, opacity = 1) =>
      new THREE.MeshToonMaterial({
        color, gradientMap: this.ramp, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
        side: THREE.DoubleSide,
      });

    // substrate (holes already cut out); its ink edges belong to the outline layer
    const body = slab(board.board.body, -t / 2, t, toon(ink.board));
    const bodyEdges = body ? this.edgesOf(body, -t / 2) : null;
    const outline = board.layers.find((l) => l.role === "outline");
    if (outline && bodyEdges) this.track(outline.id, bodyEdges);
    else if (bodyEdges) this.root.add(bodyEdges);

    for (const l of board.layers) {
      const st = styleFor(l.role);
      const top = l.role.startsWith("top_");
      const sgn = top ? 1 : -1;
      const base = (t / 2) * sgn;
      let obj: THREE.Object3D | null = null;
      if (l.role.endsWith("_copper") && l.role !== "inner_copper") {
        obj = slab(l.polys, top ? base : base - CU, CU, toon(st.color), true);
      } else if (l.role.endsWith("_silk")) {
        const z = top ? base + CU + MASK + 0.004 : base - CU - MASK - 0.004 - SILK;
        obj = slab(l.polys, z, SILK, toon(l.role === "top_silk" ? ink.paper3 : ink.paper2));
      } else if (l.role.endsWith("_paste")) {
        obj = slab(l.polys, top ? base + CU : base - CU - 0.05, 0.05, toon(ink.yellow, 0.9));
      }
      if (obj) this.track(l.id, obj);
    }

    // solder-mask coats (board minus openings), ink-tinted and see-through
    this.coats.front = slab(board.board.coats.front, t / 2 + CU + 0.002, MASK, toon(ink.green, 0.45));
    this.coats.back = slab(board.board.coats.back, -t / 2 - CU - 0.002 - MASK, MASK, toon(ink.orange, 0.45));

    this.refreshVisibility();
    if (keepCamera) this.render();
    else this.setCamera("iso");
  }

  private edgesOf(group: THREE.Group, z: number) {
    const mesh = group.children[0] as THREE.Mesh;
    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 25),
      new THREE.LineBasicMaterial({ color: ink.ink }),
    );
    lines.position.z = z;
    this.root.add(lines);
    return lines;
  }

  private track(id: string, obj: THREE.Object3D) {
    const arr = this.byLayer.get(id) ?? [];
    arr.push(obj);
    this.byLayer.set(id, arr);
  }

  refreshVisibility() {
    for (const [id, objs] of this.byLayer) objs.forEach((o) => (o.visible = isVisible(id)));
    const maskOn = (role: string) =>
      this.board?.layers.some((l) => l.role === role && isVisible(l.id)) ?? false;
    if (this.coats.front) this.coats.front.visible = maskOn("top_mask");
    if (this.coats.back) this.coats.back.visible = maskOn("bottom_mask");
    this.render();
  }

  setCamera(view: "top" | "bottom" | "iso") {
    if (!this.controls) return;
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect || 1;
    // distance that fits the board's height and width in the viewport, plus breathing room
    const fit = Math.max(this.dims.h / 2 / tan, this.dims.w / 2 / (tan * aspect));
    const d = fit * (view === "iso" ? 1.45 : 1.2);
    // Tiny Z offsets pick the screen-up direction: board top stays up; bottom view reads mirrored, like the 2D view.
    if (view === "top") this.camera.position.set(0, d, 0.001);
    else if (view === "bottom") this.camera.position.set(0, -d, -0.001);
    else this.camera.position.set(d * 0.35, d * 0.72, d * 0.62);
    this.camera.near = Math.max(d / 1000, 0.01);
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.render();
  }

  private clear() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.root.clear();
    this.byLayer.clear();
    this.coats = { front: null, back: null };
    this.render();
  }

  private resize() {
    if (!this.renderer) return;
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private render() {
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }
}
