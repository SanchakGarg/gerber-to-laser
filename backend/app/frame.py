"""Board-relative coordinate frame shared by the preview and every exported file.

Gerber is Y-up; SVG is Y-down. All output is relative to the board bbox's top-left corner,
so every file overlays 1:1 (same as the KiCad plugin). Mirroring flips X about the shared
width: x = w - x.
"""
from dataclasses import dataclass

from .geometry import polys_of


@dataclass(frozen=True)
class Frame:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def w(self):
        return self.x1 - self.x0

    @property
    def h(self):
        return self.y1 - self.y0

    def pt(self, x, y, mirror=False):
        sx = x - self.x0
        sy = self.y1 - y
        if mirror:
            sx = self.w - sx
        return sx, sy

    # ---------- serializers ----------

    def ring_d(self, coords, mirror=False):
        pts = [self.pt(x, y, mirror) for x, y in coords]
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 2:
            return ""
        head = f"M {pts[0][0]:.4f} {pts[0][1]:.4f}"
        tail = " ".join(f"L {x:.4f} {y:.4f}" for x, y in pts[1:])
        return f"{head} {tail} Z"

    def path_d(self, geom, mirror=False):
        parts = []
        for poly in polys_of(geom):
            d = self.ring_d(poly.exterior.coords, mirror)
            if d:
                parts.append(d)
            for hole in poly.interiors:
                dh = self.ring_d(hole.coords, mirror)
                if dh:
                    parts.append(dh)
        return " ".join(parts)

    def polys_json(self, geom, ndigits=4):
        """[{outer: [[x, y], ...], holes: [[[x, y], ...], ...]}] for the 3D view (unmirrored)."""
        def ring(coords):
            pts = [[round(a, ndigits) for a in self.pt(x, y)] for x, y in coords]
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts.pop()
            return pts

        return [{"outer": ring(p.exterior.coords), "holes": [ring(h.coords) for h in p.interiors]}
                for p in polys_of(geom)]
