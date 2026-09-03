"""Parse the raw binary mesh streams (structures.pkl / implants.pkl — NOT pickle) and emit
each mesh in the same binary format the surface endpoint uses ([points f32][normals f32]
[tris u4]), with smooth normals computed via vtkPolyDataNormals (like the desktop).

Stream format: meshes concatenated in meta order; per mesh with shape=[V,F]:
  [V*3 float32 LE verts][F*3 indices]   indices uint16 if V<=60000 else int32.
Mesh vertices are already in the image_crop world frame (nii world = fpoint + index).
"""
from __future__ import annotations

import os

import numpy as np
import vtk
from vtkmodules.util import numpy_support

from . import mesh_config


def _read_mesh(buf: bytes, pos: int, V: int, F: int):
    verts = np.frombuffer(buf, "<f4", V * 3, pos).reshape(V, 3)
    pos += V * 3 * 4
    if V <= 60000:
        faces = np.frombuffer(buf, "<u2", F * 3, pos).reshape(F, 3).astype(np.int64)
        pos += F * 3 * 2
    else:
        faces = np.frombuffer(buf, "<i4", F * 3, pos).reshape(F, 3).astype(np.int64)
        pos += F * 3 * 4
    return verts, faces, pos


def _compact(verts: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Drop vertices not referenced by any face and remap the indices. Some meshes (e.g.
    Promontory: 1.08M verts for 3.4k tris) carry ~1M unreferenced points, which would make
    per-slice clipping crawl."""
    used = np.unique(faces)
    if used.size == len(verts):
        return verts, faces
    remap = np.empty(len(verts), np.int64)
    remap[used] = np.arange(used.size)
    return verts[used], remap[faces]


def parse_structures(folder: str, meta: dict) -> list[dict]:
    buf = open(os.path.join(folder, "structures.pkl"), "rb").read()
    pos = 0
    out = []
    for name in meta["structures_order"]:
        s = meta["structures"][name]
        V, F = s["shape"]
        verts, faces, pos = _read_mesh(buf, pos, V, F)
        out.append({"name": name, "type_id": s["type_id"], "verts": verts, "faces": faces})
    if pos != len(buf):
        raise ValueError(f"structures.pkl: consumed {pos} of {len(buf)} bytes")
    return out


def parse_implants(folder: str, meta: dict) -> list[dict]:
    buf = open(os.path.join(folder, "implants.pkl"), "rb").read()
    pos = 0
    out = []
    for imp in meta["implants_order"]:
        d = meta["implants"][imp]
        for comp in ("Carrier", "Contacts"):
            c = d[comp]
            V, F = c["shape"]
            verts, faces, pos = _read_mesh(buf, pos, V, F)
            out.append({"name": f"{imp}_{comp}", "type_id": c["type_id"], "verts": verts, "faces": faces})
    if pos != len(buf):
        raise ValueError(f"implants.pkl: consumed {pos} of {len(buf)} bytes")
    return out


def mesh_blob(verts: np.ndarray, faces: np.ndarray) -> tuple[bytes, int, int]:
    """Build a vtkPolyData, compute smooth normals, and return (blob, n_points, n_tris)
    in the surface binary format: [points f32][normals f32][tris u4]."""
    poly = vtk.vtkPolyData()
    pts = vtk.vtkPoints()
    pts.SetData(numpy_support.numpy_to_vtk(np.ascontiguousarray(verts, "<f4"), deep=True))
    poly.SetPoints(pts)
    n = len(faces)
    offsets = (np.arange(n + 1, dtype=np.int64) * 3)
    conn = np.ascontiguousarray(faces.ravel(), dtype=np.int64)
    ca = vtk.vtkCellArray()
    ca.SetData(
        numpy_support.numpy_to_vtkIdTypeArray(offsets, deep=True),
        numpy_support.numpy_to_vtkIdTypeArray(conn, deep=True),
    )
    poly.SetPolys(ca)

    nrm = vtk.vtkPolyDataNormals()
    nrm.SetInputData(poly)
    nrm.SplittingOff()
    nrm.ConsistencyOn()
    nrm.ComputeCellNormalsOff()
    nrm.ComputePointNormalsOn()
    nrm.Update()
    out = nrm.GetOutput()

    P = numpy_support.vtk_to_numpy(out.GetPoints().GetData()).astype("<f4", copy=False)
    N = numpy_support.vtk_to_numpy(out.GetPointData().GetNormals()).astype("<f4", copy=False)
    polys = numpy_support.vtk_to_numpy(out.GetPolys().GetData())  # [3,i,j,k, 3,...]
    T = polys.reshape(-1, 4)[:, 1:4].astype("<u4", copy=False)
    body = P.tobytes() + N.tobytes() + np.ascontiguousarray(T).tobytes()
    return body, len(P), len(T)


def build_group(folder: str, meta: dict, group: str, center: np.ndarray | None = None) -> list[dict]:
    """Parse + blob every mesh in a group ('structures'|'implants'); returns items with
    manifest fields + the cached binary blob. `center` (the CT crop's physical centre) is
    subtracted from every vertex so the meshes land in the frontend Image's centred world
    frame (its world origin is the image centre, not the nii physical origin)."""
    parsed = parse_structures(folder, meta) if group == "structures" else parse_implants(folder, meta)
    items = []
    for i, m in enumerate(parsed):
        info = mesh_config.mesh_info(m["type_id"])
        cverts, faces = _compact(m["verts"], m["faces"])
        verts = cverts if center is None else (cverts - center.astype("<f4"))
        # Same L/R,A/P correction as routes.case._correct_lp_axes: rotate 180 deg about S/I
        # (negate world X,Y) so meshes stay aligned with the corrected image. 180 deg is a
        # proper rotation, so vtkPolyDataNormals still yields outward normals below.
        verts = verts * np.array([-1, -1, 1], "<f4")
        blob, n_pts, n_tris = mesh_blob(verts, faces)
        items.append({
            "index": i,
            "name": m["name"],
            "type_id": m["type_id"],
            "label": info["name"],
            "color": info["color"],
            "opacity": info["opacity"],
            "render_order": info["render_order"],
            "n_points": n_pts,
            "n_tris": n_tris,
            "blob": blob,
        })
    return items
