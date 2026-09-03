"""A `Run` rendered in POST /api/cdb's shape.

Everything the browser can display arrives this way — a finished .cdb, a live pipeline run, a
reopened job folder — so they all go through the .cdb display path rather than each growing its
own. Shared by backend/jobs.py (a run in progress) and backend/routes/job.py (a past one).
"""
from __future__ import annotations

from . import store


def cdb_payload(run, ident: str, name: str, path: str = "") -> dict:
    """`run` as the cdb-shaped payload keyed by `ident` (the mesh/graph routes look it up)."""
    from pv_core.session import Session
    from . import bake as bake_mod
    from .routes.cdb import _electrodes

    for im in run.images:
        store.put(im)
    by_id = {im.id: im for im in run.images}

    session = Session(objects=list(run.objects), state=dict(run.state)).to_dict()
    blobs: dict = {}
    for obj in session.get("objects", []):
        bake_mod.bake(obj, by_id, blobs)
        if obj.get("kind") == "lead":
            obj.get("extra", {}).pop("cie", None)

    preop, postop = run.preop(), run.postop()
    return {
        "cdbId": ident,
        "path": path,
        "name": name,
        "side": 1 if run.side == "right" else 0,
        "sides": [1 if run.side == "right" else 0],
        "images": [store.geometry_dict(im) for im in run.images],
        "top": postop.id if postop is not None else (preop.id if preop else None),
        "bottom": preop.id if preop is not None else None,
        "primary": postop.id if postop is not None else (preop.id if preop else None),
        "session": session,
        "meshes": [{"key": k, "n_points": v["n_points"], "n_tris": v["n_tris"]}
                   for k, v in blobs.items()],
        "electrodes": _electrodes(run.lead()),
        "warnings": [],
        "_blobs": blobs,
    }
