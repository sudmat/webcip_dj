"""GET /header/{id} — the Tag/Keyword/Value rows for the header viewer."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import store
from ..pvcore_path import WEBCIP_SRC  # noqa: F401 (ensures pv_core path)
from pv_core.header import get_display_header

router = APIRouter()


@router.get("/header/{image_id}")
def header(image_id: str) -> dict:
    img = store.get(image_id)
    if img is None:
        raise HTTPException(status_code=404, detail="image not loaded")
    label, columns, rows = get_display_header(img)
    return {"type": label, "columns": list(columns), "rows": [list(r) for r in rows]}
