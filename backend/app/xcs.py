"""xTool Creative Space / xTool Studio project export (.xcs): one file per board side.

The format is plain JSON (reverse-engineered from a project saved by xTool Studio 1.6.8 for the
F2 Ultra; see README "xTool .xcs export"):

- `canvas[0].layerData` holds one layer per colour, keyed "#rrggbb". Every shape ("display") names
  its layer with `layerTag`/`layerColor`.
- Shapes are PATHs. `dPath` is SVG-style (M/L/C/Z) in mm, Y down. The app puts the path's bbox
  top-left at (`x`, `y`), so we write each path in local coordinates (bbox min = 0, 0).
- Laser settings are stored per shape in `device.data.value[0][1].displays` (a serialised Map,
  keyed by shape id). Each entry carries all five process types; `processingType` picks the one used.

Layers per side (each its own colour, all in one file):

| key          | process              | offset group | geometry                                          |
|--------------|----------------------|--------------|---------------------------------------------------|
| mounting     | cut                  | etch         | jig holes (default 2 mm) at the picked holes      |
| copper       | fill engrave         | etch         | outline − copper (or copper ∩ outline, inverted)  |
| silk         | fill engrave         | etch         | silkscreen ∩ outline                              |
| mask         | fill engrave         | etch         | solder-mask openings ∩ outline                    |
| hole_engrave | fill engrave         | etch         | every hole/slot, filled (after hole tolerance)    |
| hole_cut     | cut                  | cut          | every hole/slot outline (after hole tolerance)    |
| outline_cut  | cut                  | cut          | board outline rings, inner cut-outs included      |

The board's bbox is centred on the laser bed; the back side is mirrored (DEFAULT_MIRROR_BACK).
Cut and etch layers each get their own X/Y offset, because the two lasers do not line up exactly.
Mounting holes follow the etch offset, so they sit on the etched artwork.
"""
import copy
import io
import json
import math
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from functools import lru_cache

from shapely.geometry import LineString

from .board import Board
from .config import settings
from .exporter import MAX_HOLE_TOLERANCE_MM, shrink_size, side_art
from .geometry import polys_of

CUT = "VECTOR_CUTTING"
FILL = "FILL_VECTOR_ENGRAVING"
SIDES = ("front", "back")
GROUPS = ("cut", "etch")
MAX_OFFSET_MM = 10.0
MOUNTING_RANGE_MM = (0.5, 10.0)
UA = "gerber-to-laser"
# 1x1 transparent PNG; xTool only uses `cover` as the thumbnail in its file browser.
COVER = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
         "pfZFQAAAAABJRU5ErkJggg==")
_K = 0.5522847498307936  # cubic Bézier circle constant


@dataclass(frozen=True)
class LayerSpec:
    key: str
    name: str
    color: str      # layer key in xTool, lowercase #rrggbb
    process: str    # CUT | FILL
    group: str      # offset group: "cut" | "etch"

    @property
    def is_fill(self):
        return self.process == FILL


# Order = suggested processing order (xTool `layerData.order`): jig holes first, outline last.
LAYERS = (
    LayerSpec("mounting", "Mounting holes", "#a23cf0", CUT, "etch"),
    LayerSpec("copper", "Copper · engrave", "#000000", FILL, "etch"),
    LayerSpec("silk", "Silkscreen · etch", "#2e6bff", FILL, "etch"),
    LayerSpec("mask", "Solder mask · etch", "#19a974", FILL, "etch"),
    LayerSpec("hole_engrave", "Holes · engrave", "#e1c000", FILL, "etch"),
    LayerSpec("hole_cut", "Holes · cut", "#ff7f56", CUT, "cut"),
    LayerSpec("outline_cut", "Board outline · cut", "#fe0002", CUT, "cut"),
)
LAYER_KEYS = tuple(l.key for l in LAYERS)
SPEC = {l.key: l for l in LAYERS}


def layer_table():
    """The layer list as sent to the UI (/api/config)."""
    return [{"key": l.key, "name": l.name, "color": l.color,
             "process": "cut" if l.process == CUT else "engrave", "group": l.group} for l in LAYERS]


@lru_cache(maxsize=1)
def presets():
    with open(settings.xcs_presets, encoding="utf-8") as f:
        return json.load(f)


# ---------- options ----------

@dataclass
class XcsOptions:
    sides: tuple = SIDES
    hidden: dict = field(default_factory=lambda: {s: frozenset() for s in SIDES})
    offsets: dict = field(default_factory=lambda: {g: (0.0, 0.0) for g in GROUPS})
    mounting: tuple = ()            # ((layer_id, hole_index), ...)
    mounting_diameter: float = field(default_factory=lambda: settings.mounting_hole_mm)
    hole_tolerance: float = field(default_factory=lambda: settings.hole_tolerance_mm)
    invert_copper: bool = False

    @classmethod
    def from_dict(cls, d):
        d = d or {}
        sides = tuple(s for s in SIDES if s in (d.get("sides") or SIDES))
        hidden_in = d.get("hidden") or {}
        hidden = {s: frozenset(k for k in (hidden_in.get(s) or ()) if k in SPEC) for s in SIDES}

        offsets = {}
        for g in GROUPS:
            v = (d.get("offsets") or {}).get(g) or (0, 0)
            dx, dy = float(v[0]), float(v[1])
            for a in (dx, dy):
                if not math.isfinite(a) or abs(a) > MAX_OFFSET_MM:
                    raise ValueError(f"Offsets must be within ±{MAX_OFFSET_MM:g} mm.")
            offsets[g] = (dx, dy)

        mounting = []
        for ref in d.get("mounting") or ():
            if not isinstance(ref, dict) or "layer_id" not in ref or "index" not in ref:
                raise ValueError("Mounting holes must be given as {layer_id, index}.")
            mounting.append((str(ref["layer_id"]), int(ref["index"])))

        md = d.get("mounting_diameter")
        md = settings.mounting_hole_mm if md is None or md == "" else float(md)
        lo, hi = MOUNTING_RANGE_MM
        if not lo <= md <= hi:
            raise ValueError(f"Mounting hole diameter must be between {lo:g} and {hi:g} mm.")

        tol = d.get("hole_tolerance")
        tol = settings.hole_tolerance_mm if tol is None or tol == "" else float(tol)
        if not -MAX_HOLE_TOLERANCE_MM <= tol <= MAX_HOLE_TOLERANCE_MM:
            raise ValueError(f"Hole tolerance must be between -{MAX_HOLE_TOLERANCE_MM} and {MAX_HOLE_TOLERANCE_MM} mm.")

        return cls(sides=sides, hidden=hidden, offsets=offsets, mounting=tuple(dict.fromkeys(mounting)),
                   mounting_diameter=md, hole_tolerance=tol, invert_copper=bool(d.get("invert_copper", False)))


def mounting_points(board: Board, refs):
    """Gerber-coordinate centres of the picked holes. Raises ValueError for an unknown hole."""
    pts = []
    for layer_id, index in refs:
        try:
            lyr = board.layer(layer_id)
        except KeyError:
            raise ValueError(f"Mounting hole refers to an unknown layer ({layer_id}).")
        holes = lyr.drills.holes if lyr.drills else []
        if not 0 <= index < len(holes):
            raise ValueError(f"Mounting hole {index} does not exist in {lyr.filename}.")
        x, y, _ = holes[index]
        pts.append((x, y))
    return pts


# ---------- geometry, in bed coordinates (mm, Y down, before offsets) ----------

@dataclass
class Shape:
    """One xTool PATH: a set of rings drawn as one (compound) path, or a circle."""
    rings: list = None      # [[(x, y), ...], ...]
    circle: tuple = None    # (cx, cy, r)


class Placement:
    """Board frame → laser bed: board bbox centred on the bed, back side mirrored."""

    def __init__(self, board: Board, side: str):
        self.fr = board.frame
        self.mirror = settings.default_mirror_front if side == "front" else settings.default_mirror_back
        self.x0 = settings.xcs_bed_width_mm / 2 - self.fr.w / 2
        self.y0 = settings.xcs_bed_height_mm / 2 - self.fr.h / 2

    def pt(self, x, y):
        sx, sy = self.fr.pt(x, y, self.mirror)
        return self.x0 + sx, self.y0 + sy

    def ring(self, coords):
        pts = [self.pt(x, y) for x, y in coords]
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts.pop()
        return pts if len(pts) >= 3 else None

    def rings(self, geom):
        """All rings of a geometry: exteriors and holes (even-odd)."""
        out = []
        for poly in polys_of(geom):
            for r in (poly.exterior, *poly.interiors):
                pts = self.ring(r.coords)
                if pts:
                    out.append(pts)
        return out


def side_layers(board: Board, side: str, opts: XcsOptions):
    """[(LayerSpec, [Shape])] for one side: every layer with content, hidden ones included.

    Cached on the board: offsets and hidden layers don't change geometry, so nudging an offset
    doesn't redo the copper boolean ops.
    """
    key = ("xcs", side, opts.invert_copper, opts.hole_tolerance, opts.mounting, opts.mounting_diameter)
    if key not in board.cache:
        if len(board.cache) > 16:
            board.cache.clear()
        board.cache[key] = _side_layers(board, side, opts)
    return board.cache[key]


def _side_layers(board: Board, side: str, opts: XcsOptions):
    pl = Placement(board, side)
    art = side_art(board, side, opts.invert_copper)
    tol = opts.hole_tolerance
    out = {}

    pts = mounting_points(board, opts.mounting)
    if pts:
        r = opts.mounting_diameter / 2
        out["mounting"] = [Shape(circle=(*pl.pt(x, y), r)) for x, y in pts]

    for kind in ("copper", "silk", "mask"):
        if art[kind] is not None:
            rings = pl.rings(art[kind])
            if rings:
                out[kind] = [Shape(rings=rings)]

    holes = []
    for x, y, d in board.drills.holes:
        if d > 0:
            holes.append(Shape(circle=(*pl.pt(x, y), shrink_size(d, tol) / 2)))
    for x1, y1, x2, y2, w in board.drills.slots:
        if w > 0:
            capsule = LineString([(x1, y1), (x2, y2)]).buffer(shrink_size(w, tol) / 2, quad_segs=16)
            rings = pl.rings(capsule)
            if rings:
                holes.append(Shape(rings=rings))
    if holes:
        out["hole_engrave"] = holes
        out["hole_cut"] = holes

    outline = []
    for poly in polys_of(board.outline):
        for r in (poly.exterior, *poly.interiors):   # every ring is cut on its own
            pts = pl.ring(r.coords)
            if pts:
                outline.append(Shape(rings=[pts]))
    if outline:
        out["outline_cut"] = outline

    return [(SPEC[k], out[k]) for k in LAYER_KEYS if k in out]


def _svg_d(shape):
    if shape.circle:
        cx, cy, r = shape.circle
        return (f"M {cx - r:.4f} {cy:.4f} a {r:.4f} {r:.4f} 0 1 0 {2 * r:.4f} 0 "
                f"a {r:.4f} {r:.4f} 0 1 0 {-2 * r:.4f} 0 Z")
    return " ".join("M " + " L ".join(f"{x:.4f} {y:.4f}" for x, y in ring) + " Z" for ring in shape.rings)


def preview(board: Board, opts: XcsOptions):
    """Per side, per layer: SVG path data in bed coordinates, without offsets (the UI adds them)."""
    sides = {}
    for side in opts.sides:
        sides[side] = [{"key": spec.key, "count": len(shapes), "d": " ".join(_svg_d(s) for s in shapes)}
                       for spec, shapes in side_layers(board, side, opts)]
    return sides


# ---------- xTool JSON ----------

def _local_path(shape, dx, dy):
    """(x, y, width, height, dPath) with dPath in local coordinates (bbox min at 0, 0)."""
    if shape.circle:
        cx, cy, r = shape.circle
        k = _K * r
        f = lambda v: f"{v:.4f}"
        d = (f"M {f(2 * r)} {f(r)} "
             f"C {f(2 * r)} {f(r + k)} {f(r + k)} {f(2 * r)} {f(r)} {f(2 * r)} "
             f"C {f(r - k)} {f(2 * r)} {f(0)} {f(r + k)} {f(0)} {f(r)} "
             f"C {f(0)} {f(r - k)} {f(r - k)} {f(0)} {f(r)} {f(0)} "
             f"C {f(r + k)} {f(0)} {f(2 * r)} {f(r - k)} {f(2 * r)} {f(r)} Z")
        return cx - r + dx, cy - r + dy, 2 * r, 2 * r, d
    xs = [x for ring in shape.rings for x, _ in ring]
    ys = [y for ring in shape.rings for _, y in ring]
    mx, my = min(xs), min(ys)
    d = " ".join("M " + " L ".join(f"{x - mx:.4f} {y - my:.4f}" for x, y in ring) + " Z"
                 for ring in shape.rings)
    return mx + dx, my + dy, max(xs) - mx, max(ys) - my, d


def _display(spec, shape, dx, dy, z, group_tag):
    x, y, w, h, d = _local_path(shape, dx, dy)
    color = int(spec.color[1:], 16)
    fill = spec.is_fill
    return {
        "id": str(uuid.uuid4()), "name": None, "type": "PATH",
        "x": x, "y": y, "angle": 0,
        "scale": {"x": 1, "y": 1}, "skew": {"x": 0, "y": 0},
        "pivot": {"x": 0, "y": 0}, "localSkew": {"x": 0, "y": 0},
        "offsetX": x, "offsetY": y,
        "lockRatio": True, "isClosePath": True, "zOrder": z,
        "groupTags": [group_tag], "groupTag": group_tag,
        "layerTag": spec.color, "layerColor": spec.color,
        "visible": True, "originColor": spec.color,
        "enableTransform": True, "visibleState": True, "lockState": False,
        "resourceOrigin": "", "customData": {}, "rootComponentId": "", "minCanvasVersion": "0.0.0",
        "alpha": 1,
        "fill": {"paintType": "color", "visible": fill, "color": color, "alpha": 1},
        "stroke": {"paintType": "color", "visible": True, "color": color, "alpha": 1,
                   # 0.1 mm (cut) / 1 mm (fill), in points, as xTool writes them
                   "width": 2.834645669291339 if fill else 0.2834645669291339,
                   "cap": "butt", "join": "miter", "miterLimit": 4, "alignment": 0.5},
        "effects": [],
        "width": w, "height": h,
        "isFill": fill,
        # xTool's own hint colours for filled vs. outlined shapes (copied from a saved project).
        "lineColor": 16421416 if fill else 10036991,
        "fillColor": "#f9932b" if fill else "#9928ff",
        "points": [], "dPath": d, "fillRule": "evenodd",
        "graphicX": x, "graphicY": y,
        "isCompoundPath": bool(shape.rings and len(shape.rings) > 1),
    }


def _process_entry(spec):
    p = presets()
    nodes = copy.deepcopy(p["baseNodes"])
    nodes[spec.process]["parameter"]["customize"].update(p["layers"].get(spec.key) or {})
    return {"data": nodes, "isFill": spec.is_fill, "isWhiteModel": True, "processIgnore": False,
            "processingType": spec.process, "type": "PATH"}


def build_xcs(board: Board, side: str, opts: XcsOptions):
    """The xTool project dict for one side, or None when every layer is hidden or empty."""
    p = presets()
    layer_data, group_data, displays, settings_map = {}, {}, [], []
    z = 0
    for order, (spec, shapes) in enumerate(side_layers(board, side, opts), start=1):
        if spec.key in opts.hidden[side]:
            continue
        dx, dy = opts.offsets[spec.group]
        tag = f"g-{uuid.uuid4()}"
        name = spec.name if spec.key != "mounting" else f"Mounting holes · {opts.mounting_diameter:g} mm"
        layer_data[spec.color] = {"name": name, "order": order, "visible": True}
        entry = _process_entry(spec)
        for shape in shapes:
            z += 1
            disp = _display(spec, shape, dx, dy, z, tag)
            displays.append(disp)
            settings_map.append([disp["id"], copy.deepcopy(entry)])
        group_data[tag] = {"groupName": name, "groupTag": tag, "visible": True,
                           "enableTransform": True, "zOrder": z, "rotation": 0}
    if not displays:
        return None

    canvas_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    proj, dev = p["project"], p["device"]
    return {
        "canvasId": canvas_id,
        "canvas": [{
            "id": canvas_id,
            "title": "{panel}1",
            "layerData": layer_data,
            "groupData": group_data,
            "displays": displays,
            "extendInfo": copy.deepcopy(proj["canvasExtendInfo"]),
        }],
        "extId": proj["extId"],
        "extName": proj["extName"],
        "device": {
            "id": dev["id"],
            "power": list(dev["power"]),
            "data": {"dataType": "Map", "value": [[canvas_id, {
                "mode": "LASER_PLANE",
                "data": {"LASER_PLANE": copy.deepcopy(dev["laserPlane"])},
                "displays": {"dataType": "Map", "value": settings_map},
            }]]},
            "materialList": [],
            "materialTypeList": [],
            "customProjectData": {},
        },
        "version": proj["version"],
        "created": now,
        "modify": now,
        "ua": UA,
        "meta": [],
        "cover": COVER,
        "minRequiredVersion": proj["minRequiredVersion"],
        "appMinRequiredVersion": proj["appMinRequiredVersion"],
        "webMinRequiredVersion": proj["webMinRequiredVersion"],
        "projectTraceID": str(uuid.uuid4()),
    }


def file_name(board, side):
    return f"{board.name}_{side}.xcs"


def export_xcs(board: Board, opts: XcsOptions):
    """[(side, filename, bytes)] for every requested side that has at least one visible layer."""
    out = []
    for side in opts.sides:
        proj = build_xcs(board, side, opts)
        if proj is not None:
            data = json.dumps(proj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            out.append((side, file_name(board, side), data))
    return out


def zip_files(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for _, name, data in files:
            zf.writestr(name, data)
    return buf.getvalue()
