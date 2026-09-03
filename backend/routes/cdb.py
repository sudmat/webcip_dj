"""POST /cdb — open a plan's companion ``.cdb`` read-only and hand the browser its scene.

The parsing is the desktop's, unchanged: ``projects.cip.cdb_scene.assemble`` returns the cropped
preop/postop Images (declaring their FULL geometry), the segmented structures, the implant meshes
and the localized electrode lead. It is the exact analogue of ``workspace.load_workspace``, so this
route is the cdb twin of ``routes/plan.py`` and shares its baking (``backend/bake.py``).

What is NOT sent inline: the lead's ``extra['cie']`` analytic payload. It is image-mm, feeds
``electrode.graph_series`` / ``projection``, and is far too big for the load response
(``dist_values`` alone is n x 300 floats). The derived series come from /graph and /mip instead.

A cdb is a tool OUTPUT and opens read-only (``session.state['cip']['read_only']``); the frontend
disables every clinician edit accordingly, as the desktop does (electrode_panel._edits_locked).
"""
from __future__ import annotations

import math
import os
import uuid

import numpy as np
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .. import bake as _bake_mod
from .. import store
from ..pvcore_path import WEBCIP_SRC  # noqa: F401  (sets sys.path for pv_core)

router = APIRouter()

_CDBS: dict[str, dict] = {}


def register(data: dict, run=None) -> None:
    """Put a cdb-shaped payload in the registry the mesh / graph / MIP routes read, popping its
    private `_blobs`. Used by anything that produces a scene the browser displays the .cdb way:
    a saved .cdb, a live pipeline run, a reopened job folder."""
    blobs = data.pop("_blobs", {})
    images = data.get("_images")
    if images is None and run is not None:
        images = {im.id: im for im in run.images}
    _CDBS[data["cdbId"]] = {
        "path": data.get("path", ""), "side": data["side"], "blobs": blobs,
        "lead": None if run is None else run.lead(),
        "images": images or {},
        "primary_id": data.get("primary"), "mip": None,
    }


class CdbRequest(BaseModel):
    path: str
    side: int | None = None      # 0 = left, 1 = right; default = the only side present


@router.post("/cdb")
def load_cdb(req: CdbRequest) -> dict:
    if not os.path.isfile(req.path):
        raise HTTPException(status_code=404, detail=f"cdb not found: {req.path}")
    from projects.cip import cdb_scene
    from projects.cip.cdb import Cdb

    try:
        with Cdb(req.path) as c:
            sides = list(c.sides())
    except Exception as exc:  # noqa: BLE001 — a bad file surfaces to the browser
        raise HTTPException(status_code=422, detail=f"not a readable cdb: {exc}") from exc
    if not sides:
        raise HTTPException(status_code=422, detail="the cdb contains no ear data")
    side = req.side if req.side is not None else sides[0]
    if side not in sides:
        raise HTTPException(status_code=404,
                            detail=f"the cdb has no side {side} (present: {sides})")

    try:
        scene = cdb_scene.assemble(req.path, side)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"cdb load failed: {exc}") from exc

    for img in scene.images:
        store.put(img)
    by_id = {im.id: im for im in scene.images}

    session = scene.session.to_dict()
    blobs: dict[str, dict] = {}
    lead_obj = next((o for o in scene.session.objects if o.kind == "lead"), None)
    for obj in session.get("objects", []):
        _bake_mod.bake(obj, by_id, blobs)
        if obj.get("kind") == "lead":
            # The contacts are baked (world) above; drop the analytic payload — /graph serves it.
            obj.get("extra", {}).pop("cie", None)

    cdb_id = uuid.uuid4().hex[:12]
    _CDBS[cdb_id] = {"path": req.path, "side": side, "blobs": blobs,
                     "lead": lead_obj, "images": {im.id: im for im in scene.images},
                     "primary_id": scene.primary_id, "mip": None}

    return {
        "cdbId": cdb_id,
        "path": req.path,
        "name": os.path.basename(req.path),
        "side": side,
        "sides": sides,
        "images": [store.geometry_dict(im) for im in scene.images],
        "top": scene.top_id,
        "bottom": scene.bottom_id,
        "primary": scene.primary_id,
        "session": session,
        "meshes": [{"key": k, "n_points": v["n_points"], "n_tris": v["n_tris"]}
                   for k, v in blobs.items()],
        "electrodes": _electrodes(lead_obj),
        "warnings": list(scene.warnings),
    }


@router.get("/cdb/{cdb_id}/mesh/{key}")
def mesh(cdb_id: str, key: str) -> Response:
    m = _get(cdb_id)["blobs"].get(key)
    if m is None:
        raise HTTPException(status_code=404, detail=f"no such mesh: {key}")
    return Response(
        content=m["blob"],
        media_type="application/octet-stream",
        headers={"X-NPoints": str(m["n_points"]), "X-NTris": str(m["n_tris"]),
                 "Cache-Control": "no-store"},
    )


@router.get("/cdb/{cdb_id}/graph")
def graph(cdb_id: str, setting: int | None = None) -> dict:
    """Everything the interactive Curves graph needs, for one activation setting
    (projects.cip.electrode.graph_series)."""
    from projects.cip import electrode
    lead = _get(cdb_id)["lead"]
    if lead is None:
        raise HTTPException(status_code=404, detail="the cdb has no localized lead")
    return _clean(electrode.graph_series(lead, setting))


@router.get("/cdb/{cdb_id}/mip")
def mip(cdb_id: str) -> Response:
    """The MIP projection panels as a PNG (projection.render_for_lead)."""
    arr, _pts = _mip(cdb_id)
    if arr is None:
        raise HTTPException(status_code=404, detail="the cdb has no projectable lead")
    from io import BytesIO
    from PIL import Image as _PImage
    buf = BytesIO()
    _PImage.fromarray(arr).save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png",
                    headers={"X-Width": str(arr.shape[1]), "X-Height": str(arr.shape[0]),
                             "Cache-Control": "no-store"})


@router.get("/cdb/{cdb_id}/mip/points")
def mip_points(cdb_id: str) -> dict:
    """(electrode number, x, y) in MIP-image pixels for every drawn electrode — the hit list the
    projection tab uses for click-to-select and the selection ring."""
    arr, pts = _mip(cdb_id)
    if arr is None:
        raise HTTPException(status_code=404, detail="the cdb has no projectable lead")
    return {"width": int(arr.shape[1]), "height": int(arr.shape[0]),
            "points": [{"label": int(n), "x": float(x), "y": float(y)} for n, x, y in pts]}


# --- helpers ------------------------------------------------------------------------

def _get(cdb_id: str) -> dict:
    c = _CDBS.get(cdb_id)
    if c is None:
        raise HTTPException(status_code=404, detail="cdb not loaded")
    return c


def _mip(cdb_id: str):
    """The projection, rendered once per cdb and cached (it samples the whole postop volume)."""
    c = _get(cdb_id)
    if c["mip"] is None:
        from projects.cip import projection
        lead = c["lead"]
        img = c["images"].get(c["primary_id"])
        if lead is None or img is None:
            c["mip"] = (None, [])
        else:
            c["mip"] = projection.render_for_lead(img, lead, return_positions=True)
    return c["mip"]


def _electrodes(lead) -> dict:
    """The per-electrode table + the activation settings, for the left column and the dock's
    Activation dropdown. Rows come from electrode.table_rows (real electrodes only).

    `position` is dropped from every row on purpose. table_rows reads the LIVE lead, whose
    contacts are still in image-world, while the session lead's contacts have been baked to global
    world — keeping both would ship two disagreeing copies of the same point. Contact positions
    come from the baked session lead; rows are display values only.
    """
    from projects.cip import electrode
    if lead is None:
        # The SAME shape as a populated payload, just empty. An auto-process result is fetched
        # after every step, so the dock sees this before 'Search for electrodes' has run — a
        # missing `series` key crashed its chart adapter and blanked the page.
        return {"rows": [], "series": {"number": [], "label": [], "place_freq": [],
                                       "channel_freq": [], "angle": [], "distance": []},
                "settings": [], "cur_setting": 0, "model": "", "side": "", "name": "",
                "scala_names": electrode.SCALA_NAMES}
    rows = [{k: v for k, v in r.items() if k != "position"} for r in electrode.table_rows(lead)]
    return {
        "rows": _clean(rows),
        "series": _clean(electrode.figure_series(lead)),   # the 3 analysis charts
        "settings": [s.get("name") or f"Setting {i + 1}"
                     for i, s in enumerate(getattr(lead, "settings", None) or [])],
        "cur_setting": int(getattr(lead, "cur_setting", 0) or 0),
        "model": getattr(lead, "model", "") or "",
        "side": getattr(lead, "side", "") or "",
        "name": getattr(lead, "name", "") or "",
        "scala_names": electrode.SCALA_NAMES,
    }


def _clean(v):
    """NumPy -> JSON, with non-finite floats as null. `NaN`/`Infinity` are what Python's json
    emits by default and are NOT valid JSON — JSON.parse rejects them, so a single missing
    distance would otherwise fail the whole response in the browser."""
    if isinstance(v, np.ndarray):
        return _clean(v.tolist())
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    return v
