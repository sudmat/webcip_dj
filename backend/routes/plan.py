"""POST /plan — open a V8 workspace file (.pws / .pwi) and hand the browser everything in it.

The parsing is pv_core's, unchanged: ``workspace.load_workspace`` returns the restored Images
(display + registration state already applied) and the ``Session`` of planning objects. This
route only

  * registers the Images in the store, so /volume, /header and /surface work on them,
  * bakes every mesh into GLOBAL-WORLD binary blobs (the frontend renders in global world;
    a plan object's geometry is stored in its source image's frame so it tracks that image
    under re-registration — see pv_core/plan_objects.py),
  * maps every planning-object POINT the same way (trajectory entry/target, the CIP guidance
    points, t2w, the scala A/B measures), so the browser needs no image-frame math,
  * strips the (large) vertex arrays out of the JSON — they travel as blobs.

The baking itself lives in ``backend/bake.py``, shared with the cdb route.
"""
from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .. import bake as _bake_mod
from .. import store
from ..pvcore_path import WEBCIP_SRC  # noqa: F401  (sets sys.path for pv_core)
from pv_core import workspace as _workspace

router = APIRouter()

_PLANS: dict[str, dict] = {}


class PlanRequest(BaseModel):
    path: str


@router.post("/plan")
def load_plan(req: PlanRequest) -> dict:
    if not os.path.isfile(req.path):
        raise HTTPException(status_code=404, detail=f"plan file not found: {req.path}")
    try:
        ws = _workspace.load_workspace(req.path)
    except _workspace.WorkspaceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — any decode failure surfaces to the browser
        raise HTTPException(status_code=422, detail=f"plan load failed: {exc}") from exc

    for img in ws.images:
        store.put(img)
    by_id = {im.id: im for im in ws.images}

    session = ws.session.to_dict()
    blobs: dict[str, dict] = {}
    for obj in session.get("objects", []):
        _bake_mod.bake(obj, by_id, blobs)
    ui = dict(ws.ui or {})
    _bake_mod.camera_to_world(ui, by_id.get(ws.top_id))

    plan_id = uuid.uuid4().hex[:12]
    _PLANS[plan_id] = {"path": req.path, "blobs": blobs,
                       "image_ids": [im.id for im in ws.images]}
    return {
        "planId": plan_id,
        "path": req.path,
        "name": os.path.basename(req.path),
        "images": [store.geometry_dict(im) for im in ws.images],
        "top": ws.top_id,
        "bottom": ws.bottom_id,
        "view": ws.view,
        "ui": ui,
        "session": session,
        "meshes": [{"key": k, "n_points": v["n_points"], "n_tris": v["n_tris"]}
                   for k, v in blobs.items()],
        "skipped": [{"name": rec.get("name", "image"), "reason": reason}
                    for rec, reason in ws.skipped],
        "warnings": list(ws.warnings),
    }


@router.get("/plan/{plan_id}/mesh/{key}")
def mesh(plan_id: str, key: str) -> Response:
    plan = _PLANS.get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="plan not loaded")
    m = plan["blobs"].get(key)
    if m is None:
        raise HTTPException(status_code=404, detail=f"no such mesh: {key}")
    return Response(
        content=m["blob"],
        media_type="application/octet-stream",
        headers={"X-NPoints": str(m["n_points"]), "X-NTris": str(m["n_tris"]),
                 "Cache-Control": "no-store"},
    )
