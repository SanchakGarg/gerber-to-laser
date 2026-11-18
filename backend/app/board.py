"""A parsed upload: its layers, their roles, and the derived board geometry."""
import secrets
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from shapely.geometry import box

from .config import settings
from .frame import Frame
from .geometry import (EMPTY, Drills, bounds_union, clean, drills_from_objects, open_excellon,
                       open_gerber, outline_from_objects, render_objects)
from .loader import ROLE_LABELS, ROLES, identify

SIDE_ROLES = {
    "front": {"copper": "top_copper", "silk": "top_silk", "mask": "top_mask", "paste": "top_paste"},
    "back": {"copper": "bottom_copper", "silk": "bottom_silk", "mask": "bottom_mask", "paste": "bottom_paste"},
}


@dataclass
class Layer:
    id: str
    filename: str
    fmt: str            # 'gerber' | 'excellon'
    role: str
    objects: list
    geom: object = EMPTY        # rendered area, gerber coords
    drills: Drills = None       # excellon only

    def outline(self):
        return outline_from_objects(self.objects)


@dataclass
class Board:
    id: str
    name: str
    workdir: Path
    layers: list
    ignored: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    created: float = field(default_factory=time.time)
    touched: float = field(default_factory=time.time)
    # derived
    outline: object = EMPTY
    drills: Drills = None
    drill_geom: object = EMPTY
    frame: Frame = None
    outline_warning: str = None
    # Built export files waiting to be fetched by a plain GET link: token -> (filename, media_type, bytes).
    downloads: OrderedDict = field(default_factory=OrderedDict, repr=False)
    # Derived export geometry keyed by its inputs; emptied whenever the layers change.
    cache: dict = field(default_factory=dict, repr=False)
    _dl_lock: object = field(default_factory=threading.Lock, repr=False)

    # ---------- construction ----------

    @classmethod
    def from_paths(cls, paths, workdir: Path, name=None):
        layers, ignored, warnings = [], [], []
        for p in sorted(paths, key=lambda p: p.name.lower()):
            fmt, role = identify(p)
            if fmt is None:
                ignored.append(p.name)
                continue
            try:
                if fmt == "excellon":
                    f = open_excellon(p)
                    lyr = Layer(uuid.uuid4().hex[:8], p.name, fmt, role, list(f.objects))
                    lyr.drills = drills_from_objects(lyr.objects)
                    lyr.geom = lyr.drills.geometry()
                else:
                    f = open_gerber(p)
                    lyr = Layer(uuid.uuid4().hex[:8], p.name, fmt, role, list(f.objects))
                    lyr.geom = render_objects(lyr.objects)
            except Exception as e:  # a broken file is reported, not fatal
                warnings.append(f"{p.name}: could not be parsed ({e.__class__.__name__}: {e}).")
                continue
            layers.append(lyr)

        if not layers:
            raise ValueError("No Gerber or Excellon files found in the upload.")

        board = cls(id=uuid.uuid4().hex, name=name or _common_name([l.filename for l in layers]),
                    workdir=workdir, layers=layers, ignored=ignored, warnings=warnings)
        board.rebuild()
        return board

    def set_role(self, layer_id, role):
        if role not in ROLES:
            raise ValueError(f"Unknown role {role!r}.")
        lyr = self.layer(layer_id)
        if role == "drill" and lyr.fmt != "excellon":
            raise ValueError("Only Excellon drill files can be used as drill layers.")
        if lyr.fmt == "excellon" and role != "drill":
            raise ValueError("Excellon files can only be drill layers.")
        lyr.role = role
        self.rebuild()

    def layer(self, layer_id):
        for l in self.layers:
            if l.id == layer_id:
                return l
        raise KeyError(layer_id)

    # ---------- derived geometry ----------

    def rebuild(self):
        self.cache.clear()
        self.outline_warning = None
        outline_layers = [l for l in self.layers if l.role == "outline"]
        outline = EMPTY
        notes = []
        for l in outline_layers:
            poly, warn = l.outline()
            if warn:
                notes.append(f"{l.filename}: {warn}")
            if not poly.is_empty:
                outline = poly if outline.is_empty else clean(outline.symmetric_difference(poly))

        if outline.is_empty:
            content = [l.geom for l in self.layers if l.role not in ("other",) and not l.geom.is_empty]
            b = bounds_union(*content)
            if b is None:
                b = (0, 0, 10, 10)
            outline = box(b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1)
            notes.append("No closed board outline found; using the artwork's bounding box + 1 mm.")
        self.outline = outline
        self.outline_warning = " ".join(notes) or None

        self.drills = Drills()
        for l in self.layers:
            if l.role == "drill" and l.drills:
                self.drills.extend(l.drills)
        self.drill_geom = self.drills.geometry()

        x0, y0, x1, y1 = self.outline.bounds
        self.frame = Frame(x0, y0, x1, y1)

    def role_geom(self, role):
        geoms = [l.geom for l in self.layers if l.role == role and not l.geom.is_empty]
        if not geoms:
            return EMPTY
        if len(geoms) == 1:
            return geoms[0]
        return clean(_union(geoms))

    def has_role(self, role):
        return any(l.role == role for l in self.layers)

    # ---------- API view ----------

    def view(self):
        fr = self.frame
        simplify = settings.preview_simplify_mm
        board_body = clean(self.outline.difference(self.drill_geom)) if not self.drill_geom.is_empty else self.outline

        layers = []
        for l in self.layers:
            entry = {
                "id": l.id,
                "filename": l.filename,
                "format": l.fmt,
                "role": l.role,
                "label": self._label(l),
            }
            if l.fmt == "excellon":
                entry["holes"] = [[*map(lambda v: round(v, 4), fr.pt(x, y)), round(d, 4)]
                                  for x, y, d in l.drills.holes]
                entry["slots"] = [[*map(lambda v: round(v, 4), fr.pt(x1, y1)),
                                   *map(lambda v: round(v, 4), fr.pt(x2, y2)), round(w, 4)]
                                  for x1, y1, x2, y2, w in l.drills.slots]
                entry["d"] = fr.path_d(l.geom)
                entry["polys"] = []
            else:
                g = l.geom.simplify(simplify) if simplify > 0 else l.geom
                entry["d"] = fr.path_d(g)
                # 3D: keep what is on the board, minus holes.
                g3 = clean(g.intersection(self.outline))
                if not self.drill_geom.is_empty and l.role.endswith(("copper", "mask", "silk")):
                    g3 = clean(g3.difference(self.drill_geom))
                entry["polys"] = fr.polys_json(g3) if l.role != "outline" else []
            layers.append(entry)

        # Solder-mask coat per side for 3D = board − mask openings − holes.
        coats = {}
        for side, roles in SIDE_ROLES.items():
            openings = self.role_geom(roles["mask"])
            coats[side] = fr.polys_json(clean(board_body.difference(openings))) if self.has_role(roles["mask"]) else []

        sides_present = [s for s, r in SIDE_ROLES.items()
                         if any(self.has_role(r[k]) for k in ("copper", "silk", "mask"))]

        return {
            "session_id": self.id,
            "name": self.name,
            "board": {
                "width": round(fr.w, 4),
                "height": round(fr.h, 4),
                "outline_d": fr.path_d(self.outline),
                "body": fr.polys_json(board_body),
                "coats": coats,
                "thickness": settings.board_thickness_mm,
            },
            "layers": layers,
            "sides_present": sides_present,
            "ignored": self.ignored,
            "warnings": self.warnings + ([self.outline_warning] if self.outline_warning else []),
        }

    def _label(self, l):
        if l.role != "other":
            return ROLE_LABELS.get(l.role, l.role)
        stem = l.filename.rsplit(".", 1)[0]
        if self.name and stem.startswith(self.name):
            stem = stem[len(self.name):]
        return stem.strip("-_. ") or ROLE_LABELS["other"]

    # ---------- downloads ----------

    MAX_DOWNLOADS = 12

    def stash(self, filename, media_type, data):
        """Keep a built file for a later GET; returns its token. Oldest entries are dropped."""
        token = secrets.token_urlsafe(12)
        with self._dl_lock:
            self.downloads[token] = (filename, media_type, data)
            while len(self.downloads) > self.MAX_DOWNLOADS:
                self.downloads.popitem(last=False)
        return token

    def fetch(self, token):
        with self._dl_lock:
            return self.downloads.get(token)

    def cleanup(self):
        self.downloads.clear()
        shutil.rmtree(self.workdir, ignore_errors=True)


def _union(geoms):
    from shapely.ops import unary_union
    return unary_union(geoms)


def _common_name(names):
    stems = [n.rsplit(".", 1)[0] for n in names]
    if not stems:
        return "board"
    prefix = stems[0]
    for s in stems[1:]:
        while prefix and not s.startswith(prefix):
            prefix = prefix[:-1]
    prefix = prefix.rstrip("-_. ")
    return prefix or "board"
