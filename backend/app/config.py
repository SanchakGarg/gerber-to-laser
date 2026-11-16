"""Runtime settings, read once from environment variables (see .env.example)."""
import os
from dataclasses import dataclass


def _bool(name, default):
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _num(name, default, cast=float):
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return cast(v)


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    log_level: str
    cors_origins: tuple
    max_upload_mb: float
    max_files: int
    session_ttl_minutes: float
    max_sessions: int
    arc_tolerance_mm: float
    preview_simplify_mm: float
    board_thickness_mm: float
    default_dpi: int
    max_dpi: int
    default_mirror_front: bool
    default_mirror_back: bool
    hole_tolerance_mm: float
    static_dir: str


def load_settings() -> Settings:
    origins = os.environ.get("CORS_ORIGINS", "").strip()
    return Settings(
        host=os.environ.get("HOST", "0.0.0.0"),
        port=_num("PORT", 8000, int),
        log_level=os.environ.get("LOG_LEVEL", "info"),
        cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        max_upload_mb=_num("MAX_UPLOAD_MB", 50.0),
        max_files=_num("MAX_FILES", 64, int),
        session_ttl_minutes=_num("SESSION_TTL_MINUTES", 60.0),
        max_sessions=_num("MAX_SESSIONS", 32, int),
        arc_tolerance_mm=_num("ARC_TOLERANCE_MM", 0.005),
        preview_simplify_mm=_num("PREVIEW_SIMPLIFY_MM", 0.002),
        board_thickness_mm=_num("BOARD_THICKNESS_MM", 1.6),
        default_dpi=_num("DEFAULT_DPI", 1000, int),
        max_dpi=_num("MAX_DPI", 2400, int),
        default_mirror_front=_bool("DEFAULT_MIRROR_FRONT", False),
        default_mirror_back=_bool("DEFAULT_MIRROR_BACK", True),
        hole_tolerance_mm=_num("HOLE_TOLERANCE_MM", 0.2),
        static_dir=os.environ.get(
            "STATIC_DIR",
            os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"),
        ),
    )


settings = load_settings()
