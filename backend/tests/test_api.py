import io
import zipfile

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _zip(board_dir):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for p in board_dir.iterdir():
            zf.write(p, f"gerbers/{p.name}")
    return buf.getvalue()


def test_upload_zip_preview_export(board_dir):
    r = client.post("/api/upload", files=[("files", ("board.zip", _zip(board_dir), "application/zip"))])
    assert r.status_code == 200, r.text
    v = r.json()
    sid = v["session_id"]
    assert v["board"]["width"] == 10 and v["board"]["height"] == 10
    assert {l["role"] for l in v["layers"]} >= {"top_copper", "bottom_copper", "outline", "drill"}
    assert v["sides_present"] == ["front", "back"]

    r = client.post(f"/api/session/{sid}/export/preview", json={"sides": ["front"]})
    assert r.status_code == 200
    assert len(r.json()["files"]) == 5

    r = client.post(f"/api/session/{sid}/export", json={})
    assert r.status_code == 200
    link = r.json()
    assert link["name"] == "test_laser.zip" and link["size"] > 0
    r = client.get(link["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].startswith('attachment; filename="test_laser.zip"')

    layer = next(l for l in v["layers"] if l["role"] == "bottom_copper")
    r = client.patch(f"/api/session/{sid}/layers/{layer['id']}", json={"role": "other"})
    assert r.status_code == 200 and r.json()["sides_present"] == ["front"]


def test_upload_multiple_files(board_dir):
    files = [("files", (p.name, p.read_bytes(), "application/octet-stream")) for p in board_dir.iterdir()]
    r = client.post("/api/upload", files=files)
    assert r.status_code == 200


def test_bad_upload():
    r = client.post("/api/upload", files=[("files", ("x.txt", b"hello", "text/plain"))])
    assert r.status_code == 400


def test_unknown_session():
    assert client.get("/api/session/nope").status_code == 404


def _upload(board_dir):
    r = client.post("/api/upload", files=[("files", ("board.zip", _zip(board_dir), "application/zip"))])
    assert r.status_code == 200, r.text
    return r.json()


def test_config_lists_xcs_layers():
    cfg = client.get("/api/config").json()["xcs"]
    assert cfg["bed"] == {"w": 220, "h": 220} and cfg["mounting_hole_mm"] == 2
    assert [l["key"] for l in cfg["layers"]][-1] == "outline_cut"


def test_xcs_preview_and_download(board_dir):
    v = _upload(board_dir)
    sid = v["session_id"]
    drl = next(l for l in v["layers"] if l["role"] == "drill")
    r = client.post(f"/api/session/{sid}/xcs", json={
        "hidden": {"back": ["copper"]}, "offsets": {"cut": [0.1, 0], "etch": [0, 0]},
        "mounting": [{"layer_id": drl["id"], "index": 0}]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bed"] == {"w": 220, "h": 220}
    front, back = body["sides"]["front"], body["sides"]["back"]
    assert [l["key"] for l in front["layers"]][0] == "mounting"
    assert "copper" in [l["key"] for l in back["layers"]]          # preview keeps hidden layers
    assert front["file"]["name"] == "test_front.xcs" and back["file"]["name"] == "test_back.xcs"

    r = client.get(back["file"]["url"])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"] == (
        'attachment; filename="test_back.xcs"; filename*=UTF-8\'\'test_back.xcs')
    assert r.headers["cache-control"] == "no-store"
    layer_data = r.json()["canvas"][0]["layerData"]
    assert "#000000" not in layer_data and "#a23cf0" in layer_data

    r = client.get(body["zip"]["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert sorted(zf.namelist()) == ["test_back.xcs", "test_front.xcs"]


def test_xcs_bad_mounting_ref(board_dir):
    sid = _upload(board_dir)["session_id"]
    r = client.post(f"/api/session/{sid}/xcs", json={"mounting": [{"layer_id": "zzz", "index": 0}]})
    assert r.status_code == 400


def test_unknown_download_token(board_dir):
    sid = _upload(board_dir)["session_id"]
    assert client.get(f"/api/session/{sid}/download/nope").status_code == 404
