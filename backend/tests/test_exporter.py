import io
import re
import zipfile

import pytest
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from app.exporter import ExportOptions, export_svgs, export_zip


def parse_svg(text):
    """Filled area of an exported SVG (paths even-odd per element, plus circles)."""
    geoms = []
    for d in re.findall(r'<path d="([^"]+)"[^>]*fill="black"', text):
        acc = Polygon()
        for sub in re.findall(r"M[^M]+", d):
            nums = list(map(float, re.findall(r"-?[\d.]+", sub)))
            pts = list(zip(nums[0::2], nums[1::2]))
            if len(pts) >= 3:
                acc = acc.symmetric_difference(Polygon(pts).buffer(0))
        geoms.append(acc)
    for cx, cy, r in re.findall(r'<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.-]+)"', text):
        geoms.append(Point(float(cx), float(cy)).buffer(float(r), quad_segs=64))
    return unary_union(geoms) if geoms else Polygon()


def files(board, **kw):
    return dict(export_svgs(board, ExportOptions(**kw)))


def test_file_set_and_names(board):
    f = files(board)
    assert set(f) == {
        "test_front_copper.svg", "test_front_silk.svg", "test_front_mask.svg",
        "test_front_cut.svg", "test_front_drill.svg",
        "test_back_copper.svg", "test_back_cut.svg", "test_back_drill.svg",
    }


def test_shared_bbox(board):
    for text in files(board).values():
        assert 'width="10.0000mm" height="10.0000mm" viewBox="0 0 10.0000 10.0000"' in text


def test_copper_is_negative(board):
    text = files(board)["test_front_copper.svg"]
    burned = parse_svg(text)
    cu = board.role_geom("top_copper")
    assert burned.area == pytest.approx(100 - cu.area, rel=2e-3)
    # Pad centre (105,108) -> SVG (5, 2) must NOT be burned; free board corner must be.
    assert not burned.contains(Point(5, 2))
    assert burned.contains(Point(9.5, 9.5))


def test_invert_copper(board):
    burned = parse_svg(files(board, invert_copper=True)["test_front_copper.svg"])
    assert burned.contains(Point(5, 2))


def test_y_down_and_mirror(board):
    # Drill at gerber (105,102) -> svg (5, 8); mirrored x = 10 - 5 = 5. Use the region instead:
    front = parse_svg(files(board, mirror_front=False)["test_front_mask.svg"])
    assert front.centroid.x == pytest.approx(5, abs=1e-3) and front.centroid.y == pytest.approx(2, abs=1e-3)
    silk = parse_svg(files(board, mirror_front=False)["test_front_silk.svg"])
    silk_m = parse_svg(files(board, mirror_front=True)["test_front_silk.svg"])
    # silk line spans gerber x 101..104 -> svg x 1..4, mirrored 6..9
    assert silk.bounds[0] == pytest.approx(0.9, abs=1e-3)
    assert silk_m.bounds[2] == pytest.approx(9.1, abs=1e-3)
    assert silk.bounds[1] == pytest.approx(0.9, abs=1e-3)  # y = 110 - 109 - 0.1


def test_back_mirrored_by_default(board):
    f = files(board)
    assert 'cx="5.0000" cy="8.0000"' in f["test_back_drill.svg"]
    back = parse_svg(f["test_back_copper.svg"])
    front = parse_svg(f["test_front_copper.svg"])
    # region at gerber x 101.5..102.5 is unburned; mirrored it sits at x 7.5..8.5
    assert not front.contains(Point(2, 8)) and front.contains(Point(8, 8))
    assert not back.contains(Point(8, 8)) and back.contains(Point(2, 8))


def test_cut_has_no_background(board):
    text = files(board)["test_front_cut.svg"]
    assert "<rect" not in text
    assert 'fill="none"' in text and 'stroke="red"' in text and 'stroke-width="0.1"' in text


def test_kinds_and_sides_filter(board):
    f = files(board, sides=("back",), kinds={"copper": True, "silk": False, "mask": False,
                                             "cut": False, "drill": False})
    assert list(f) == ["test_back_copper.svg"]


def test_zip(board):
    data = export_zip(board, ExportOptions(sides=("front",)))
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert "test_front_copper.svg" in names and len(names) == 5
