import json
import re
import tempfile
from pathlib import Path

import pytest

from app import xcs
from app.board import Board
from app.xcs import XcsOptions, build_xcs, export_xcs

BED = 220.0
NODES = {"COLOR_FILL_ENGRAVE", "FILL_VECTOR_ENGRAVING", "INTAGLIO", "VECTOR_CUTTING", "VECTOR_ENGRAVING"}


@pytest.fixture
def board2(board_dir):
    """The test board with an extra off-centre 1.2 mm hole at (102, 107) — mirroring is visible."""
    (board_dir / "test.drl").write_text(
        "M48\nMETRIC,TZ\nT1C0.800\nT2C1.200\n%\nG90\nG05\nT1\nX105.0Y102.0\nT2\nX102.0Y107.0\nM30\n")
    return Board.from_paths(list(board_dir.iterdir()), Path(tempfile.mkdtemp()))


def drill_layer(board):
    return next(l for l in board.layers if l.fmt == "excellon")


def opts(**kw):
    return XcsOptions.from_dict(kw)


def by_layer(proj):
    out = {}
    for d in proj["canvas"][0]["displays"]:
        out.setdefault(d["layerTag"], []).append(d)
    return out


def centre(d):
    return d["x"] + d["width"] / 2, d["y"] + d["height"] / 2


def color(key):
    return xcs.SPEC[key].color


def local_bounds(dpath):
    nums = [float(n) for n in re.findall(r"-?\d+\.?\d*", dpath)]
    xs, ys = nums[0::2], nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def test_structure_joins(board):
    proj = build_xcs(board, "front", opts())
    canvas = proj["canvas"][0]
    assert proj["canvasId"] == canvas["id"]
    dev = proj["device"]["data"]
    assert dev["dataType"] == "Map" and dev["value"][0][0] == canvas["id"]
    entries = dict(dev["value"][0][1]["displays"]["value"])
    ids = [d["id"] for d in canvas["displays"]]
    assert set(entries) == set(ids) and len(ids) == len(set(ids))
    for d in canvas["displays"]:
        e = entries[d["id"]]
        assert set(e["data"]) == NODES
        assert e["processingType"] in NODES and e["processIgnore"] is False
        assert e["isFill"] == d["isFill"]
        assert d["layerTag"] in canvas["layerData"]
        assert all(g in canvas["groupData"] for g in d["groupTags"])
    assert proj["extName"] == "F2 Ultra"
    json.dumps(proj)  # serialisable


def test_front_layers_and_processes(board):
    layers = by_layer(build_xcs(board, "front", opts()))
    assert set(layers) == {color(k) for k in ("copper", "silk", "mask", "hole_engrave", "hole_cut", "outline_cut")}
    cu = layers[color("copper")]
    assert len(cu) == 1 and cu[0]["isCompoundPath"] and cu[0]["isFill"] and cu[0]["fill"]["visible"]
    assert not layers[color("outline_cut")][0]["isFill"]


def test_back_has_no_front_only_art(board):
    layers = by_layer(build_xcs(board, "back", opts()))
    assert color("silk") not in layers and color("mask") not in layers
    assert color("copper") in layers and color("hole_cut") in layers and color("outline_cut") in layers


def test_settings_follow_presets(board):
    proj = build_xcs(board, "front", opts())
    entries = dict(proj["device"]["data"]["value"][0][1]["displays"]["value"])
    for d in proj["canvas"][0]["displays"]:
        e = entries[d["id"]]
        if d["layerTag"] == color("copper"):
            assert e["processingType"] == "FILL_VECTOR_ENGRAVING"
            assert e["data"]["FILL_VECTOR_ENGRAVING"]["parameter"]["customize"]["repeat"] == 12
        if d["layerTag"] == color("outline_cut"):
            assert e["processingType"] == "VECTOR_CUTTING"
            cut = e["data"]["VECTOR_CUTTING"]["parameter"]["customize"]
            assert cut["power"] == 100 and cut["enableKerf"] is False


def test_board_centred_on_bed(board):
    for side in ("front", "back"):
        outline = by_layer(build_xcs(board, side, opts()))[color("outline_cut")]
        assert centre(outline[0]) == pytest.approx((BED / 2, BED / 2))


def test_local_paths_start_at_origin(board2):
    for d in build_xcs(board2, "front", opts())["canvas"][0]["displays"]:
        x0, y0, x1, y1 = local_bounds(d["dPath"])
        assert (x0, y0) == pytest.approx((0, 0), abs=1e-3)
        assert (x1, y1) == pytest.approx((d["width"], d["height"]), abs=1e-3)
        assert d["offsetX"] == d["graphicX"] == d["x"]


def test_back_is_mirrored(board2):
    # Hole (102, 107) -> board frame (2, 3); bed origin of the board = 105 -> (107, 108).
    def hole_centres(side):
        return sorted(centre(d) for d in by_layer(build_xcs(board2, side, opts()))[color("hole_cut")])
    front, back = hole_centres("front"), hole_centres("back")
    assert any(c == pytest.approx((107, 108)) for c in front)
    assert any(c == pytest.approx((113, 108)) for c in back)
    assert sorted(BED - x for x, _ in front) == pytest.approx(sorted(x for x, _ in back))


def test_hole_tolerance_applies(board2):
    holes = by_layer(build_xcs(board2, "front", opts(hole_tolerance=0.2)))[color("hole_cut")]
    assert sorted(round(d["width"], 4) for d in holes) == [0.6, 1.0]
    engrave = by_layer(build_xcs(board2, "front", opts(hole_tolerance=0)))[color("hole_engrave")]
    assert sorted(round(d["width"], 4) for d in engrave) == [0.8, 1.2]


def test_offsets_move_their_group(board2):
    base = by_layer(build_xcs(board2, "front", opts()))
    moved = by_layer(build_xcs(board2, "front", opts(offsets={"cut": [0.5, -0.25], "etch": [-1, 2]})))
    for key, (dx, dy) in {"outline_cut": (0.5, -0.25), "hole_cut": (0.5, -0.25),
                          "copper": (-1, 2), "silk": (-1, 2), "mask": (-1, 2), "hole_engrave": (-1, 2)}.items():
        for a, b in zip(base[color(key)], moved[color(key)]):
            assert (b["x"] - a["x"], b["y"] - a["y"]) == pytest.approx((dx, dy))


def test_hidden_layers_are_left_out(board):
    proj = build_xcs(board, "front", opts(hidden={"front": ["silk", "hole_engrave"]}))
    canvas = proj["canvas"][0]
    assert color("silk") not in canvas["layerData"] and color("hole_engrave") not in canvas["layerData"]
    assert {d["layerTag"] for d in canvas["displays"]}.isdisjoint({color("silk"), color("hole_engrave")})
    # other side untouched
    assert color("hole_engrave") in build_xcs(board, "back", opts(hidden={"front": ["hole_engrave"]}))["canvas"][0]["layerData"]


def test_all_hidden_side_is_skipped(board):
    o = opts(hidden={"back": list(xcs.LAYER_KEYS)})
    assert build_xcs(board, "back", o) is None
    assert [s for s, _, _ in export_xcs(board, o)] == ["front"]


def test_mounting_layer(board2):
    drl = drill_layer(board2)
    o = opts(mounting=[{"layer_id": drl.id, "index": 1}], offsets={"etch": [0.3, 0.4], "cut": [9, 9]},
             hole_tolerance=0)
    for side, cx in (("front", 107), ("back", 113)):
        layers = by_layer(build_xcs(board2, side, o))
        mount = layers[color("mounting")]
        assert len(mount) == 1
        # the picked hole itself, at its drilled size
        assert mount[0]["width"] == pytest.approx(1.2) and not mount[0]["isFill"]
        # follows the cut offset (the flip axis must match the cut layers), not the etch one
        assert centre(mount[0]) == pytest.approx((cx + 9, 108 + 9))
        # and it is no longer in the hole layers: only the other hole is left there
        for key in ("hole_cut", "hole_engrave"):
            assert len(layers[color(key)]) == 1
            assert layers[color(key)][0]["width"] == pytest.approx(0.8)


def test_mounting_follows_hole_tolerance(board2):
    drl = drill_layer(board2)
    proj = build_xcs(board2, "front", opts(mounting=[{"layer_id": drl.id, "index": 0}], hole_tolerance=0.2))
    assert by_layer(proj)[color("mounting")][0]["width"] == pytest.approx(xcs.shrink_size(0.8, 0.2))


def test_all_holes_picked_leaves_no_hole_layers(board2):
    drl = drill_layer(board2)
    proj = build_xcs(board2, "front", opts(mounting=[{"layer_id": drl.id, "index": i} for i in (0, 1)]))
    layers = by_layer(proj)
    assert len(layers[color("mounting")]) == 2
    assert color("hole_cut") not in layers and color("hole_engrave") not in layers


def test_no_mounting_layer_without_picks(board):
    assert color("mounting") not in build_xcs(board, "front", opts())["canvas"][0]["layerData"]


@pytest.mark.parametrize("bad", [
    {"mounting": [{"layer_id": "nope", "index": 0}]},
    {"offsets": {"cut": [11, 0]}},
    {"hole_tolerance": 5},
])
def test_bad_options(board, bad):
    with pytest.raises(ValueError):
        build_xcs(board, "front", XcsOptions.from_dict(bad)) if "mounting" in bad else XcsOptions.from_dict(bad)


def test_bad_mounting_index(board):
    o = opts(mounting=[{"layer_id": drill_layer(board).id, "index": 7}])
    with pytest.raises(ValueError):
        build_xcs(board, "front", o)


def test_export_files_are_json(board):
    files = export_xcs(board, opts())
    assert [(s, n) for s, n, _ in files] == [("front", "test_front.xcs"), ("back", "test_back.xcs")]
    for _, _, data in files:
        assert json.loads(data)["canvas"][0]["displays"]


def test_preview_lists_hidden_layers_too(board):
    prev = xcs.preview(board, opts(hidden={"front": ["silk"]}))
    keys = [l["key"] for l in prev["front"]]
    assert "silk" in keys and keys == [k for k in xcs.LAYER_KEYS if k in keys]
    assert all(l["d"].startswith("M ") and l["count"] >= 1 for l in prev["front"])
