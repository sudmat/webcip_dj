"""Result-display case endpoints: load a case folder (cropped CT + structure/implant meshes
+ electrode curves) and serve them to the vtk.js display app.

A case folder holds: meta.json, stats.json, curves.json, image_crop.nii, structures.pkl,
implants.pkl. Meshes are parsed once on load (mesh_io) and their binary blobs cached.
"""
from __future__ import annotations

import json
import os
import uuid

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .. import mesh_io, store

router = APIRouter()

_CASES: dict[str, dict] = {}


class CaseRequest(BaseModel):
    folder: str


@router.post("/case")
def load_case(req: CaseRequest) -> dict:
    folder = req.folder
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail=f"not a folder: {folder}")
    try:
        meta = _json(folder, "meta.json")
        stats = _json(folder, "stats.json") if os.path.exists(os.path.join(folder, "stats.json")) else {}
        image_name = meta.get("data_files", {}).get("image", "image_crop.nii")
        img = store.load_path(os.path.join(folder, image_name), name=f"{meta.get('plan_id', 'case')} crop")
        center = img.center_phys  # shift meshes into the Image's centred world frame
        groups = {
            "structures": mesh_io.build_group(folder, meta, "structures", center),
            "implants": mesh_io.build_group(folder, meta, "implants", center),
        }
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"case load failed: {exc}") from exc

    case_id = uuid.uuid4().hex[:12]
    _CASES[case_id] = {"folder": folder, "image_id": img.id, "meta": meta, "stats": stats, "groups": groups}
    geo = store.geometry_dict(img)
    _correct_lp_axes(geo)
    return {
        "caseId": case_id,
        "imageId": img.id,
        "image": geo,
        "meta": meta,
        "stats": stats,
    }


def _correct_lp_axes(geo: dict) -> None:
    """The case NIfTIs encode L/R and A/P inverted (S/I is correct), so the raw header
    renders mirror-flipped vs the v2 display. Rotate the image 180 deg about the S/I axis
    by negating the L and P rows of the direction cosines (world X,Y of the image content).
    mesh_io.build_group applies the identical rotation to the meshes so both stay aligned."""
    d = geo["direction"]  # row-major 3x3: rows 0=L, 1=P, 2=S
    for i in range(6):
        d[i] = -d[i]


@router.get("/case/{case_id}/curves")
def curves(case_id: str) -> Response:
    case = _get(case_id)
    path = os.path.join(case["folder"], "curves.json")
    if not os.path.exists(path):
        return Response(content="{}", media_type="application/json")
    return Response(content=open(path, "rb").read(), media_type="application/json")


@router.get("/case/{case_id}/meshes/{group}")
def manifest(case_id: str, group: str) -> dict:
    case = _get(case_id)
    if group not in ("structures", "implants"):
        raise HTTPException(status_code=404, detail="unknown group")
    items = [{k: v for k, v in m.items() if k != "blob"} for m in case["groups"][group]]
    return {"group": group, "meshes": items}


@router.get("/case/{case_id}/mesh/{group}/{index}")
def mesh(case_id: str, group: str, index: int) -> Response:
    case = _get(case_id)
    meshes = case["groups"].get(group, [])
    if index < 0 or index >= len(meshes):
        raise HTTPException(status_code=404, detail="no such mesh")
    m = meshes[index]
    return Response(
        content=m["blob"],
        media_type="application/octet-stream",
        headers={"X-NPoints": str(m["n_points"]), "X-NTris": str(m["n_tris"]), "Cache-Control": "no-store"},
    )


def _get(case_id: str) -> dict:
    case = _CASES.get(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="case not loaded")
    return case


def _json(folder: str, name: str) -> dict:
    return json.load(open(os.path.join(folder, name)))
