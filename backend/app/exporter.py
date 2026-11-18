"""Laser SVG export — a port of pcb_fab_laser/exporter.py (KiCad plugin) to Gerber input.

Files per side, `<board>_<side>_<kind>.svg`:

| kind   | content                                         | laser meaning                                   |
|--------|-------------------------------------------------|-------------------------------------------------|
| copper | board outline − copper  (negative)              | burn paint off everything that is not copper    |
| silk   | silkscreen ∩ outline    (positive)              | silkscreen artwork, its own job                 |
| mask   | solder-mask openings ∩ outline (positive)       | strip paint off pads after etch (plugin "pads") |
| cut    | outline, fill none, red 0.1 mm stroke, no bg    | cut the board out                               |
| drill  | hole/slot outlines, same style as cut           | cut the holes out                               |

Drill is written once, from the first exported side (front when both): `<board>_front_drill.svg`
or `<board>_back_drill.svg`, mirrored like that side. Holes and slots are shrunk by `hole_tolerance` (diameter/width, mm) so the laser kerf
doesn't overcut them; a negative tolerance enlarges them.

All files share the board-outline bbox, so they overlay 1:1. Mirror flips X per side.
"""
import io
import os
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

from shapely.geometry import LineString

from .board import SIDE_ROLES, Board
from .config import settings
from .geometry import clean

KINDS = ("copper", "silk", "mask", "cut", "drill")
MAX_HOLE_TOLERANCE_MM = 2.0
CUT_STYLE = {"fill": "none", "stroke": "red", "stroke_width": 0.1}
MIN_HOLE_MM = 0.1   # tolerance never shrinks a hole below this (or below its own size, if smaller)


@dataclass
class ExportOptions:
    sides: tuple = ("front", "back")
    kinds: dict = field(default_factory=lambda: {k: True for k in KINDS})
    mirror_front: bool = False
    mirror_back: bool = True
    invert_copper: bool = False
    png: bool = False
    dpi: int = 1000
    hole_tolerance: float = field(default_factory=lambda: settings.hole_tolerance_mm)

    @classmethod
    def from_dict(cls, d):
        d = d or {}
        sides = tuple(s for s in ("front", "back") if s in (d.get("sides") or ("front", "back")))
        kinds = {k: bool((d.get("kinds") or {}).get(k, True)) for k in KINDS}
        dpi = int(d.get("dpi") or settings.default_dpi)
        if not 1 <= dpi <= settings.max_dpi:
            raise ValueError(f"DPI must be between 1 and {settings.max_dpi}.")
        tol = d.get("hole_tolerance")
        tol = settings.hole_tolerance_mm if tol is None or tol == "" else float(tol)
        if not -MAX_HOLE_TOLERANCE_MM <= tol <= MAX_HOLE_TOLERANCE_MM:
            raise ValueError(f"Hole tolerance must be between -{MAX_HOLE_TOLERANCE_MM} and {MAX_HOLE_TOLERANCE_MM} mm.")
        return cls(
            sides=sides,
            kinds=kinds,
            mirror_front=bool(d.get("mirror_front", settings.default_mirror_front)),
            mirror_back=bool(d.get("mirror_back", settings.default_mirror_back)),
            invert_copper=bool(d.get("invert_copper", False)),
            png=bool(d.get("png", False)),
            dpi=dpi,
            hole_tolerance=tol,
        )


def export_svgs(board: Board, opts: ExportOptions):
    """Return [(filename, svg_text)] for every requested file that has content."""
    out = []
    for side in opts.sides:
        # Holes go through the board, so front and back drill files would be identical:
        # emit one, from the first exported side (front when both); its name says which.
        out.extend(_export_side(board, side, opts, drill=side == opts.sides[0]))
    return out


def side_art(board, side, invert_copper=False):
    """Laser artwork per kind for one side, in Gerber coordinates. None = nothing to write.

    copper: outline − copper (burn everything that is not copper), or copper ∩ outline when inverted.
    It is kept even when empty, as long as the side has a copper layer. silk/mask: ∩ outline, if any.
    """
    roles = SIDE_ROLES[side]
    outline = board.outline
    art = {"copper": None, "silk": None, "mask": None}
    if board.has_role(roles["copper"]):
        copper = board.role_geom(roles["copper"])
        art["copper"] = clean(copper.intersection(outline)) if invert_copper else clean(outline.difference(copper))
    for kind in ("silk", "mask"):
        if board.has_role(roles[kind]):
            g = clean(board.role_geom(roles[kind]).intersection(outline))
            art[kind] = None if g.is_empty else g
    return art


def _export_side(board, side, opts, drill=True):
    mirror = opts.mirror_front if side == "front" else opts.mirror_back
    fr = board.frame
    outline = board.outline

    def name(kind):
        return f"{board.name}_{side}_{kind}.svg"

    files = []
    art = side_art(board, side, opts.invert_copper)
    for kind in ("copper", "silk", "mask"):
        if opts.kinds.get(kind) and art[kind] is not None:
            files.append((name(kind), _svg(fr, [_path(fr, art[kind], mirror)])))

    if opts.kinds.get("cut"):
        # Laser software imports the background rect as a shape and would cut it;
        # the outline alone already spans the bbox.
        files.append((name("cut"), _svg(fr, [_path(fr, outline, mirror, **CUT_STYLE)], background=False)))

    if drill and opts.kinds.get("drill") and (board.drills.holes or board.drills.slots):
        # Holes are cut with the laser too, so they get the cut file's look: outlines, no background.
        files.append((name("drill"), _svg(
            fr, _drill_elems(fr, board.drills, mirror, opts.hole_tolerance), background=False)))

    return files


def _path(fr, geom, mirror, fill="black", stroke="none", stroke_width=0.0):
    d = fr.path_d(geom, mirror)
    if not d:
        return ""
    attrs = [f'd="{d}"', f'fill="{escape(fill)}"', 'fill-rule="evenodd"', f'stroke="{escape(stroke)}"']
    if stroke_width > 0:
        attrs.append(f'stroke-width="{stroke_width}"')
    return f'  <path {" ".join(attrs)}/>'


def shrink_size(size, tol):
    """Hole diameter / slot width after tolerance, floored at MIN_HOLE_MM (or the original size)."""
    return max(size - tol, min(size, MIN_HOLE_MM))


def _drill_elems(fr, drills, mirror, tol=0.0):
    body = []
    for x, y, d in drills.holes:
        cx, cy = fr.pt(x, y, mirror)
        r = shrink_size(d, tol) / 2
        body.append(f'  <circle cx="{cx:.4f}" cy="{cy:.4f}" r="{r:.4f}" fill="none" stroke="red" '
                    f'stroke-width="{CUT_STYLE["stroke_width"]}"/>')
    for x1, y1, x2, y2, w in drills.slots:
        capsule = LineString([(x1, y1), (x2, y2)]).buffer(shrink_size(w, tol) / 2, quad_segs=16)
        body.append(_path(fr, capsule, mirror, **CUT_STYLE))
    return body


def _svg(fr, body, background=True):
    w, h = fr.w, fr.h
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
        f'width="{w:.4f}mm" height="{h:.4f}mm" viewBox="0 0 {w:.4f} {h:.4f}">\n'
        + (f'  <rect x="0" y="0" width="{w:.4f}" height="{h:.4f}" fill="white"/>\n' if background else "")
        + "\n".join(b for b in body if b) + "\n"
        "</svg>\n"
    )


# ---------- PNG ----------

def rasterizer():
    for name in ("rsvg-convert", "inkscape", "magick", "convert"):
        path = shutil.which(name)
        if path:
            return name, path
    return None, None


def rasterize(svg_text, dpi):
    tool, path = rasterizer()
    if tool is None:
        raise RuntimeError("PNG requested but no rasterizer found (install rsvg-convert, inkscape or imagemagick).")
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "in.svg")
        dst = os.path.join(td, "out.png")
        with open(src, "w", encoding="utf-8") as f:
            f.write(svg_text)
        if tool == "rsvg-convert":
            cmd = [path, "-d", str(dpi), "-p", str(dpi), "-b", "white", "-o", dst, src]
        elif tool == "inkscape":
            cmd = [path, src, "--export-type=png", f"--export-dpi={dpi}", f"--export-filename={dst}",
                   "--export-background=white", "--export-background-opacity=1.0"]
        else:
            cmd = [path, "-density", str(dpi), "-background", "white", "-flatten", src, dst]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f"{tool} failed (exit {proc.returncode}): {proc.stderr.strip()}")
        with open(dst, "rb") as f:
            return f.read()


def export_zip(board: Board, opts: ExportOptions):
    files = export_svgs(board, opts)
    if not files:
        raise ValueError("Nothing to export with these options.")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, svg in files:
            zf.writestr(fname, svg)
            if opts.png:
                zf.writestr(fname[:-4] + ".png", rasterize(svg, opts.dpi))
    return buf.getvalue()
