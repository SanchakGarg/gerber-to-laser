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
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"

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
