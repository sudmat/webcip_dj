"""Bake planning objects into the frame the browser renders in.

The web renderers work in GLOBAL WORLD. A planning object is stored in its source image's frame
(``coord_space: "image_world"``) so it tracks that image under re-registration
(pv_core/plan_objects.py), and the desktop maps it out at draw time. We do it once here instead,
so the frontend needs no image-frame math: every point comes over already in global world and
every mesh as a binary blob.

Shared by the plan (`.pws`/`.pwi`) and cdb routes — both hand back the same object kinds.
"""
from __future__ import annotations

import numpy as np

from . import plan_mesh
from .pvcore_path import WEBCIP_SRC  # noqa: F401  (sets sys.path for pv_core)
from pv_core import geometry as geo

# A preop trajectory is only a few mm long; like IDL's _DrawTraj the desktop draws it as a line
# extended from the target through the entry to this length (four_up_viewer._TRAJ_DISPLAY_LEN).
TRAJ_DISPLAY_LEN = 30.0


def to_world(obj: dict, by_id: dict):
    """The 4x4 mapping this object's stored coordinates into GLOBAL world, or None when it is
    already there. A localized object lives in its source image's frame (coord_space
    "image_world"), so global world is inv(source.world_matrix) — the same mapping
    four_up_viewer._rebuild_contour_meshes / _carrier_world_polydata apply."""
    if obj.get("coord_space") != "image_world":
        return None
    src = by_id.get(obj.get("source_image"))
    return None if src is None else np.linalg.inv(src.world_matrix)


def pts(mat, points):
    """Map a point / list of points through `mat` (identity when None), as plain lists."""
    if points is None:
        return None
    arr = np.asarray(points, float)
    flat = arr.ndim == 1
    out = arr.reshape(1, 3) if flat else arr
    if mat is not None:
        out = geo.apply_to_points(mat, out)
    return [float(v) for v in out[0]] if flat else [[float(c) for c in p] for p in out]


def bake(obj: dict, by_id: dict, blobs: dict) -> None:
    """Rewrite one planning object in place: geometry into global world, meshes into blobs."""
    mat = to_world(obj, by_id)
    kind = obj.get("kind")
    oid = obj.get("id", "")

    if kind == "structure":
        b = plan_mesh.blob(plan_mesh.polydata(obj.get("mesh"), mat))
        if b is not None:
            blobs[f"struct:{oid}"] = b
        obj["mesh"] = None
        # `extra` is only a SHALLOW copy from to_dict(), so extra['ab'] is the live Structure's
        # own dict — transforming it in place would corrupt the source, and re-baking the same
        # objects (the auto-process result is rebuilt after every step) would transform it again
        # and again. Copy before writing.
        extra = obj.get("extra") or {}
        ab = extra.get("ab")
        if ab:
            ab = dict(ab)
            for key in ("pa", "pb"):
                if ab.get(key):
                    ab[key] = pts(mat, ab[key])
            extra["ab"] = ab

    elif kind == "trajectory":
        obj["entry"] = pts(mat, obj.get("entry"))
        obj["target"] = pts(mat, obj.get("target"))
        extra = obj.get("extra") or {}
        cip = dict(extra.get("cip") or {})      # copy: see the `ab` note above
        b = plan_mesh.blob(plan_mesh.polydata(cip.get("carrier_mesh"), mat))
        if b is not None:
            blobs[f"carrier:{oid}"] = b
        if cip.get("points"):
            cip["points"] = pts(mat, cip["points"])
        if cip.get("t2w") is not None and mat is not None:
            # t2w maps trajectory space -> image world; compose to land in global world.
            cip["t2w"] = (mat @ np.asarray(cip["t2w"], float)).tolist()
        if "carrier_mesh" in cip:
            cip["carrier_mesh"] = None
        if cip:
            extra["cip"] = cip
        track = _track(obj)
        if track is not None:
            blobs[f"track:{oid}"] = track

    elif kind == "lead":
        # A localized electrode lead: the contacts are the geometry. The analytic `cie` payload is
        # NOT baked here — it is image-mm, feeds electrode.graph_series / projection, and is far too
        # big for JSON (dist_values alone is n x 300 floats); the cdb route strips it and serves the
        # derived series from its own endpoints.
        for c in obj.get("contacts") or []:
            c["position"] = pts(mat, c.get("position"))

    if mat is not None:
        obj["coord_space"] = "world"    # everything above is now global world


def _track(traj: dict) -> dict | None:
    """The yellow track cylinder along the trajectory's DISPLAY line — target extended toward
    entry to TRAJ_DISPLAY_LEN, exactly like four_up_viewer._traj_display_line, so a few-mm
    insertion still reads as an approach. Endpoints are already global world here."""
    entry, target = traj.get("entry"), traj.get("target")
    if not entry or not target:
        return None
    e = np.asarray(entry, float)
    t = np.asarray(target, float)
    d = e - t
    n = float(np.linalg.norm(d))
    far = e if n < 1e-6 else t + d / n * TRAJ_DISPLAY_LEN
    return plan_mesh.blob(plan_mesh.tube(t, far), weld=False)


def camera_to_world(ui: dict, top) -> None:
    """Map a saved 3D camera into global world, in place.

    The desktop's 3D pane is NOT in world space — sitk_to_vtk puts the volume in the top image's
    PHYSICAL frame, so everything drawn there goes through
    ``world_to_scene = translation(center_phys) @ world_matrix`` (four_up_viewer.world_to_scene).
    The browser's 3D view renders global world directly, so the saved camera has to come back the
    other way or it ends up hundreds of mm from the anatomy.
    """
    cam = (ui.get("camera3d") or {}) if ui else {}
    if not cam or top is None:
        return
    inv = (np.linalg.inv(top.world_matrix)
           @ geo.translation(-np.asarray(top.center_phys, float)))
    cam["position"] = pts(inv, cam["position"])
    cam["focal"] = pts(inv, cam["focal"])
    cam["view_up"] = [float(v) for v in geo.apply_to_vectors(inv, cam["view_up"])[0]]
