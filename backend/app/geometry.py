"""Gerber / Excellon → shapely geometry, in millimetres, Gerber coordinates (Y up).

Every graphic primitive gerbonara yields is turned into a filled shapely polygon. Gerber
polarity is honoured in file order: consecutive dark primitives are unioned, a clear run
is subtracted from everything drawn so far.
"""
import math
import warnings
from dataclasses import dataclass, field

import shapely
from gerbonara import ExcellonFile, GerberFile
from gerbonara import graphic_primitives as gp
from gerbonara.utils import MM, approximate_arc
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import polygonize, unary_union

from .config import settings

EMPTY = Polygon()


def _quad_segs(radius):
    """Segments per quarter circle so the chord error stays under the arc tolerance."""
    tol = settings.arc_tolerance_mm
    if radius <= tol:
        return 2
    step = 2 * math.acos(max(-1.0, 1 - tol / radius))
    return max(2, min(64, math.ceil((math.pi / 2) / step)))


def _arc_points(a):
    if a.is_circle:
        r = math.dist((a.x1, a.y1), (a.cx, a.cy))
        n = max(8, _quad_segs(r) * 4)
        return [(a.cx + r * math.cos(2 * math.pi * i / n), a.cy + r * math.sin(2 * math.pi * i / n))
                for i in range(n + 1)]
    return list(approximate_arc(a.cx, a.cy, a.x1, a.y1, a.x2, a.y2, a.clockwise,
                                max_error=settings.arc_tolerance_mm))


def primitive_to_shape(p):
    """Filled area of one gerbonara graphic primitive, or None."""
    if isinstance(p, gp.Circle):
        if p.r <= 0:
            return None
        return Point(p.x, p.y).buffer(p.r, quad_segs=_quad_segs(p.r))
    if isinstance(p, gp.Line):
        if p.width <= 0:
            return None
        r = p.width / 2
        if math.isclose(p.x1, p.x2, abs_tol=1e-9) and math.isclose(p.y1, p.y2, abs_tol=1e-9):
            return Point(p.x1, p.y1).buffer(r, quad_segs=_quad_segs(r))
        return LineString([(p.x1, p.y1), (p.x2, p.y2)]).buffer(r, quad_segs=_quad_segs(r))
    if isinstance(p, gp.Arc):
        if p.width <= 0:
            return None
        r = p.width / 2
        pts = _arc_points(p)
        if len(pts) < 2:
            return Point(p.x1, p.y1).buffer(r, quad_segs=_quad_segs(r))
        return LineString(pts).buffer(r, quad_segs=_quad_segs(r))
    if isinstance(p, gp.Rectangle):
        if p.w <= 0 or p.h <= 0:
            return None
        rect = box(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2)
        if p.rotation:
            rect = affinity.rotate(rect, p.rotation, origin=(p.x, p.y), use_radians=True)
        return rect
    if isinstance(p, gp.ArcPoly):
        pts = p.approximate_arcs(max_error=settings.arc_tolerance_mm).outline
        if len(pts) < 3:
            return None
        return shapely.make_valid(Polygon(pts))
    return None


def _primitives(obj):
    try:
        return obj.to_primitives(MM)
    except Exception:
        # An aperture macro gerbonara can't expand must not abort the whole layer.
        return []


def render_objects(objects):
    """Union of all objects' primitives with polarity applied, as a (Multi)Polygon."""
    result = EMPTY
    run, run_dark = [], True

    def flush():
        nonlocal result, run
        if not run:
            return
        u = unary_union(run)
        result = unary_union([result, u]) if run_dark else result.difference(u)
        run = []

    for obj in objects:
        for prim in _primitives(obj):
            shape = primitive_to_shape(prim)
            if shape is None or shape.is_empty:
                continue
            dark = bool(getattr(prim, "polarity_dark", True))
            if dark != run_dark:
                flush()
                run_dark = dark
            run.append(shape)
    flush()
    return clean(result)


def clean(geom):
    if geom is None or geom.is_empty:
        return EMPTY
    geom = shapely.make_valid(geom)
    polys = [g for g in _iter_polys(geom) if g.area > 1e-9]
    if not polys:
        return EMPTY
    return unary_union(polys)


def _iter_polys(geom):
    if isinstance(geom, Polygon):
        yield geom
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from _iter_polys(g)


def polys_of(geom):
    return list(_iter_polys(geom))


# ---------- outline ----------

def outline_from_objects(objects):
    """Closed board outline from an outline layer's stroke centrelines, the way the KiCad
    plugin uses the Edge.Cuts outline. Nested loops are combined even-odd, so an inner loop
    is a cutout. Returns (polygon_or_EMPTY, warning_or_None)."""
    segments = []
    for obj in objects:
        for prim in _primitives(obj):
            if isinstance(prim, gp.Line):
                if (prim.x1, prim.y1) != (prim.x2, prim.y2):
                    segments.append(LineString([(prim.x1, prim.y1), (prim.x2, prim.y2)]))
            elif isinstance(prim, gp.Arc):
                pts = _arc_points(prim)
                if len(pts) >= 2:
                    segments.append(LineString(pts))
            elif isinstance(prim, (gp.ArcPoly, gp.Rectangle)):
                # Some tools export the outline as a filled region.
                shape = primitive_to_shape(prim)
                if shape is not None and not shape.is_empty:
                    for poly in _iter_polys(shape):
                        segments.append(LineString(poly.exterior.coords))

    if not segments:
        return EMPTY, "Outline layer has no lines or arcs."

    # Snap near-coincident endpoints (CAD exports often leave µm gaps), node, polygonize.
    merged = unary_union([shapely.set_precision(s, 1e-4) for s in segments])
    faces = list(polygonize(merged))
    if not faces:
        hull = merged.convex_hull
        if isinstance(hull, Polygon) and hull.area > 0:
            return hull, "Outline is not closed; using its convex hull."
        return EMPTY, "Outline is not closed."

    rings = sorted((Polygon(f.exterior) for f in faces), key=lambda p: -p.area)
    board = EMPTY
    for ring in rings:
        board = board.symmetric_difference(ring)
    return clean(board), None


# ---------- drills ----------

@dataclass
class Drills:
    holes: list = field(default_factory=list)   # (x, y, diameter)
    slots: list = field(default_factory=list)   # (x1, y1, x2, y2, width)

    def extend(self, other):
        self.holes.extend(other.holes)
        self.slots.extend(other.slots)

    def geometry(self):
        shapes = [Point(x, y).buffer(d / 2, quad_segs=_quad_segs(d / 2)) for x, y, d in self.holes if d > 0]
        shapes += [LineString([(x1, y1), (x2, y2)]).buffer(w / 2, quad_segs=_quad_segs(w / 2))
                   for x1, y1, x2, y2, w in self.slots if w > 0]
        return clean(unary_union(shapes)) if shapes else EMPTY


def drills_from_objects(objects):
    d = Drills()
    for obj in objects:
        for prim in _primitives(obj):
            if isinstance(prim, gp.Circle):
                d.holes.append((prim.x, prim.y, prim.r * 2))
            elif isinstance(prim, gp.Line):
                if math.isclose(prim.x1, prim.x2, abs_tol=1e-9) and math.isclose(prim.y1, prim.y2, abs_tol=1e-9):
                    d.holes.append((prim.x1, prim.y1, prim.width))
                else:
                    d.slots.append((prim.x1, prim.y1, prim.x2, prim.y2, prim.width))
            elif isinstance(prim, gp.Arc):
                pts = _arc_points(prim)
                for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                    d.slots.append((ax, ay, bx, by, prim.width))
    return d


# ---------- file loading ----------

def open_gerber(path):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return GerberFile.open(path)


def open_excellon(path):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return ExcellonFile.open(path)


def bounds_union(*geoms):
    bs = [g.bounds for g in geoms if g is not None and not g.is_empty]
    if not bs:
        return None
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


__all__ = [
    "EMPTY", "Drills", "MultiPolygon", "bounds_union", "clean", "drills_from_objects", "open_excellon",
    "open_gerber", "outline_from_objects", "polys_of", "render_objects",
]
