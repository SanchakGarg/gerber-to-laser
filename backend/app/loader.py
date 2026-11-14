"""Upload unpacking and layer-role identification."""
import os
import re
import zipfile
from pathlib import Path

from gerbonara.layers import _layername_autoguesser, identify_file

ROLES = (
    "top_copper", "bottom_copper",
    "top_silk", "bottom_silk",
    "top_mask", "bottom_mask",
    "top_paste", "bottom_paste",
    "outline", "drill", "inner_copper", "other",
)

ROLE_LABELS = {
    "top_copper": "F.Cu", "bottom_copper": "B.Cu",
    "top_silk": "F.Silkscreen", "bottom_silk": "B.Silkscreen",
    "top_mask": "F.Mask", "bottom_mask": "B.Mask",
    "top_paste": "F.Paste", "bottom_paste": "B.Paste",
    "outline": "Edge.Cuts", "drill": "Drill", "inner_copper": "Inner Cu", "other": "Other",
}

IGNORED_EXT = {
    "gbrjob", "pdf", "png", "jpg", "jpeg", "svg", "txt.bak", "md", "rpt", "log", "zip", "step",
    "kicad_pcb", "kicad_pro", "kicad_sch", "kicad_prl", "html", "csv", "pos", "ipc", "d356",
}

EXT_ROLES = {
    "gtl": "top_copper", "gbl": "bottom_copper",
    "gto": "top_silk", "gbo": "bottom_silk",
    "gts": "top_mask", "gbs": "bottom_mask",
    "gtp": "top_paste", "gbp": "bottom_paste",
    "gko": "outline", "gm1": "outline", "gml": "outline", "gmb": "outline", "gm": "outline",
    "oln": "outline", "out": "outline", "dim": "outline", "bor": "outline",
    # Eagle CAM
    "cmp": "top_copper", "sol": "bottom_copper",
    "plc": "top_silk", "pls": "bottom_silk",
    "stc": "top_mask", "sts": "bottom_mask",
    "crc": "top_paste", "crs": "bottom_paste",
}

# Checked against the lower-cased file name, in order.
NAME_RULES = [
    (r"edge[._]?cuts|outline|profile|board[._]?outline|mechanical\s*1\b", "outline"),
    (r"(^|[^a-z])(f|front|top)[._-]?(silk(s|screen)?|legend|overlay)", "top_silk"),
    (r"(^|[^a-z])(b|back|bot(tom)?)[._-]?(silk(s|screen)?|legend|overlay)", "bottom_silk"),
    (r"(^|[^a-z])(f|front|top)[._-]?(solder)?[._-]?mask", "top_mask"),
    (r"(^|[^a-z])(b|back|bot(tom)?)[._-]?(solder)?[._-]?mask", "bottom_mask"),
    (r"(^|[^a-z])(f|front|top)[._-]?paste", "top_paste"),
    (r"(^|[^a-z])(b|back|bot(tom)?)[._-]?paste", "bottom_paste"),
    (r"(^|[^a-z])(f|front|top)[._-]?(cu|copper|layer)", "top_copper"),
    (r"(^|[^a-z])(b|back|bot(tom)?)[._-]?(cu|copper|layer)", "bottom_copper"),
    (r"courtyard|crtyd|fab|adhes|glue|margin|user|dwgs|cmts|eco\d|assembly|keepout", "other"),
]

X2_FUNC = re.compile(r"%TF\.FileFunction,([^*%]*)\*?%")


class UploadError(ValueError):
    pass


def extract_upload(files, dest: Path, max_bytes: int, max_files: int):
    """Write uploaded (name, bytes) pairs into `dest`; .zip uploads are expanded safely.
    Returns list of Paths."""
    out = []
    total = 0

    def add(name, data):
        nonlocal total
        base = os.path.basename(name.replace("\\", "/"))
        if not base or base.startswith(".") or base.startswith("__MACOSX"):
            return
        total += len(data)
        if total > max_bytes:
            raise UploadError(f"Upload exceeds {max_bytes // (1024 * 1024)} MB.")
        if len(out) >= max_files:
            raise UploadError(f"Too many files (max {max_files}).")
        target = dest / base
        n = 1
        while target.exists():
            target = dest / f"{Path(base).stem}_{n}{Path(base).suffix}"
            n += 1
        target.write_bytes(data)
        out.append(target)

    for name, data in files:
        if name.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(_bytes_io(data)) as zf:
                    for info in zf.infolist():
                        if info.is_dir() or "__MACOSX" in info.filename:
                            continue
                        if info.file_size > max_bytes:
                            raise UploadError(f"{info.filename} is too large.")
                        add(info.filename, zf.read(info))
            except zipfile.BadZipFile as e:
                raise UploadError(f"{name}: not a valid zip file.") from e
        else:
            add(name, data)
    return out


def _bytes_io(data):
    import io
    return io.BytesIO(data)


def _x2_role(text):
    m = X2_FUNC.search(text)
    if not m:
        return None
    parts = [p.strip().lower() for p in m.group(1).split(",")]
    kind = parts[0]
    side = next((p for p in parts[1:] if p in ("top", "bot", "inr")), None)
    if kind == "copper":
        return {"top": "top_copper", "bot": "bottom_copper", "inr": "inner_copper"}.get(side)
    if kind == "soldermask":
        return {"top": "top_mask", "bot": "bottom_mask"}.get(side)
    if kind == "legend":
        return {"top": "top_silk", "bot": "bottom_silk"}.get(side)
    if kind == "paste":
        return {"top": "top_paste", "bot": "bottom_paste"}.get(side)
    if kind == "profile":
        return "outline"
    if kind in ("plated", "nonplated"):
        return "other"  # Gerber-format drill maps; we use Excellon for holes.
    return "other"


def identify(path: Path):
    """Return (format, role) where format is 'gerber', 'excellon' or None (not a CAM file)."""
    name = path.name.lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    if ext in IGNORED_EXT or name.endswith(".gbrjob"):
        return None, None
    try:
        with open(path, "r", errors="ignore") as f:
            text = f.read(65536)
    except OSError:
        return None, None

    fmt = identify_file(text)
    if fmt == "excellon":
        return "excellon", "drill"
    if fmt != "gerber":
        return None, None

    role = _x2_role(text)
    if role:
        return "gerber", role
    if ext in EXT_ROLES:
        return "gerber", EXT_ROLES[ext]
    for pattern, r in NAME_RULES:
        if re.search(pattern, name):
            return "gerber", r

    side, use = _layername_autoguesser(path.name).split(" ", 1)
    if use == "outline":
        return "gerber", "outline"
    if side in ("top", "bottom") and use in ("copper", "silk", "mask", "paste"):
        return "gerber", f"{side}_{use}"
    if side.startswith("inner"):
        return "gerber", "inner_copper"
    return "gerber", "other"
