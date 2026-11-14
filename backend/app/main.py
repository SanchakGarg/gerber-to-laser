"""FastAPI app: upload Gerbers, inspect layers, export laser SVGs. Also serves the built UI."""
import logging
import os
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .board import Board
from .config import settings
from .exporter import KINDS, ExportOptions, export_svgs, export_zip, rasterizer
from .loader import ROLE_LABELS, ROLES, UploadError, extract_upload
from .sessions import store

log = logging.getLogger("gerber2laser")
app = FastAPI(title="Gerber → Laser", version="0.1.0")

if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                       allow_methods=["*"], allow_headers=["*"])


class RoleUpdate(BaseModel):
    role: str


def _board(session_id):
    board = store.get(session_id)
    if board is None:
        raise HTTPException(404, "Session expired or not found. Upload the files again.")
    return board


def _safe_name(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "board"


@app.get("/api/config")
def config():
    return {
        "roles": [{"id": r, "label": ROLE_LABELS[r]} for r in ROLES],
        "kinds": list(KINDS),
        "defaults": {
            "mirror_front": settings.default_mirror_front,
            "mirror_back": settings.default_mirror_back,
            "dpi": settings.default_dpi,
            "max_dpi": settings.max_dpi,
        },
        "max_upload_mb": settings.max_upload_mb,
        "board_thickness_mm": settings.board_thickness_mm,
        "png_available": rasterizer()[0] is not None,
    }


@app.get("/api/health")
def health():
    return {"ok": True, "sessions": len(store)}


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...)):
    max_bytes = int(settings.max_upload_mb * 1024 * 1024)
    payload = []
    total = 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > max_bytes:
            raise HTTPException(413, f"Upload exceeds {settings.max_upload_mb:g} MB.")
        payload.append((f.filename or "file", data))

    workdir = Path(tempfile.mkdtemp(prefix="g2l_"))
    try:
        paths = extract_upload(payload, workdir, max_bytes, settings.max_files)
        board = await run_in_threadpool(Board.from_paths, paths, workdir)
    except (UploadError, ValueError) as e:
        _rm(workdir)
        raise HTTPException(400, str(e))
    except Exception as e:
        _rm(workdir)
        log.exception("upload failed")
        raise HTTPException(500, f"Could not process upload: {e}")
    board.name = _safe_name(board.name)
    store.put(board)
    return await run_in_threadpool(board.view)


@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    return await run_in_threadpool(_board(session_id).view)


@app.patch("/api/session/{session_id}/layers/{layer_id}")
async def set_role(session_id: str, layer_id: str, body: RoleUpdate):
    board = _board(session_id)
    try:
        await run_in_threadpool(board.set_role, layer_id, body.role)
    except KeyError:
        raise HTTPException(404, "Layer not found.")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await run_in_threadpool(board.view)


def _opts(body):
    try:
        return ExportOptions.from_dict(body)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/session/{session_id}/export/preview")
async def export_preview(session_id: str, body: dict):
    board = _board(session_id)
    files = await run_in_threadpool(export_svgs, board, _opts(body))
    return {"files": [{"name": n, "svg": s} for n, s in files]}


@app.post("/api/session/{session_id}/export")
async def export(session_id: str, body: dict):
    board = _board(session_id)
    opts = _opts(body)
    try:
        data = await run_in_threadpool(export_zip, board, opts)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{board.name}_laser.zip"'})


def _rm(path):
    import shutil
    shutil.rmtree(path, ignore_errors=True)


# ---------- static UI ----------

_static = Path(settings.static_dir).resolve()
if _static.is_dir():
    if (_static / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=_static / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        target = (_static / path).resolve()
        if path and target.is_file() and _static in target.parents:
            return FileResponse(target)
        return FileResponse(_static / "index.html")


def run():
    import uvicorn
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_level=settings.log_level)


if __name__ == "__main__":
    run()
