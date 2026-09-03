"""Colour-scheme list + palettes from the IDL colors1.tbl (pv_core.colortable)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..pvcore_path import WEBCIP_SRC  # noqa: F401
from pv_core import colortable

router = APIRouter()


@router.get("/colormaps")
def colormaps() -> dict:
    return {"names": colortable.scheme_names()}


@router.get("/colormap/{index}")
def colormap(index: int) -> dict:
    try:
        rgb = colortable.palette(index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail="no such colormap") from exc
    return {
        "index": index,
        "name": colortable.scheme_names()[index],
        "rgb": [[int(v) for v in row] for row in rgb],  # 256 x 3
    }
