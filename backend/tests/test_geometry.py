import math

import pytest


def test_roles_identified(board):
    roles = {l.filename: l.role for l in board.layers}
    assert roles == {
        "test-Edge_Cuts.gm1": "outline",
        "test-F_Cu.gtl": "top_copper",
        "test-F_Mask.gts": "top_mask",
        "test-F_Silkscreen.gto": "top_silk",
        "test-B_Cu.gbl": "bottom_copper",
        "test.drl": "drill",
    }
    assert board.ignored == ["test-job.gbrjob"]


def test_outline_is_closed_square(board):
    assert board.outline.bounds == pytest.approx((100, 100, 110, 110))
    assert board.outline.area == pytest.approx(100, abs=1e-6)
    assert board.outline_warning is None


def test_copper_polarity_and_shapes(board):
    cu = board.role_geom("top_copper")
    # trace 6x1 + two round caps (pi*0.25) + 2x2 pad + 1x1 region - clear dot (pi*0.0625)
    expected = 6 + math.pi * 0.25 + 4 + 1 - math.pi * 0.0625
    assert cu.area == pytest.approx(expected, rel=2e-3)
    assert not cu.contains(__import__("shapely").geometry.Point(105, 105))


def test_drills(board):
    assert board.drills.holes == [pytest.approx((105, 102, 0.8))]


def test_cutout_even_odd():
    from app.geometry import outline_from_objects
    from gerbonara.graphic_objects import Line
    from gerbonara.apertures import CircleAperture
    from gerbonara.utils import MM

    ap = CircleAperture(0.1, unit=MM)

    def loop(x0, y0, x1, y1):
        pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
        return [Line(*a, *b, aperture=ap, unit=MM) for a, b in zip(pts, pts[1:])]

    poly, warn = outline_from_objects(loop(0, 0, 20, 20) + loop(5, 5, 10, 10))
    assert warn is None
    assert poly.area == pytest.approx(400 - 25)


def test_missing_outline_falls_back(board_dir, tmp_path):
    from app.board import Board
    (board_dir / "test-Edge_Cuts.gm1").unlink()
    b = Board.from_paths(list(board_dir.iterdir()), tmp_path)
    assert b.outline_warning and "bounding box" in b.outline_warning
    assert not b.outline.is_empty


def test_set_role_rebuilds(board):
    lyr = next(l for l in board.layers if l.role == "outline")
    board.set_role(lyr.id, "other")
    assert board.outline_warning is not None
    with pytest.raises(ValueError):
        board.set_role(lyr.id, "drill")
