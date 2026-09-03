"""Plan meshes -> the browser's binary mesh blob.

A plan object's mesh is ``{"vertices": [[x,y,z], …], "faces": [[i,j,k], …]}`` in the object's
``coord_space``. This module bakes one into GLOBAL-WORLD vtkPolyData and packs it in the same
blob layout the frontend already parses for case meshes (points f32 | normals f32 | tris u32,
see api/client.ts::parseMeshBlob and routes/surface.py).

Ported from the desktop's `four_up_viewer._structure_polydata` / `_rebuild_contour_meshes`
(the weld) / `_structure_actor` (the normals) / `_tube_pd`, which cannot be imported here
because that module pulls in Qt.
"""
from __future__ import annotations

import numpy as np
import vtk
from vtkmodules.util import numpy_support
from vtkmodules.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray

TRACK_RADIUS = 0.1      # mm — trajectory track cylinder (IDL track_diameter 0.2)


def polydata(mesh: dict | None, transform=None) -> vtk.vtkPolyData | None:
    """A vtkPolyData for one plan mesh, or None if it has no usable geometry. `transform`,
    when given, is a 4x4 pre-applied to the vertices (the coord_space -> global-world map)."""
    mesh = mesh or {}
    verts = mesh.get("vertices")
    faces = mesh.get("faces")
    if not verts or not faces:
        return None

    v = np.asarray(verts, float)
    f = np.asarray(faces, np.int64)
    if transform is not None:
        v = (np.asarray(transform, float) @ np.hstack([v, np.ones((len(v), 1))]).T).T[:, :3]

    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(np.ascontiguousarray(v), deep=1))

    # Modern vtkCellArray: an offsets array (where each cell starts) + flat connectivity.
    offsets = np.arange(len(f) + 1, dtype=np.int64) * 3
    ca = vtk.vtkCellArray()
    ca.SetData(numpy_to_vtkIdTypeArray(offsets, deep=1),
               numpy_to_vtkIdTypeArray(np.ascontiguousarray(f.ravel()), deep=1))

    pd = vtk.vtkPolyData()
    pd.SetPoints(points)
    pd.SetPolys(ca)
    return pd


def tube(p0, p1, radius: float = TRACK_RADIUS) -> vtk.vtkPolyData | None:
    """A capped cylinder between two world points (the trajectory track)."""
    p0 = np.asarray(p0, float)
    p1 = np.asarray(p1, float)
    if np.allclose(p0, p1):
        return None
    line = vtk.vtkLineSource()
    line.SetPoint1(*p0)
    line.SetPoint2(*p1)
    t = vtk.vtkTubeFilter()
    t.SetInputConnection(line.GetOutputPort())
    t.SetRadius(float(radius))
    t.SetNumberOfSides(16)
    t.CappingOn()
    t.Update()
    return t.GetOutput()


def blob(pd: vtk.vtkPolyData | None, weld: bool = True) -> dict | None:
    """Pack a polydata into the browser blob: {"blob", "n_points", "n_tris"}.

    `weld` runs vtkCleanPolyData first — CIP's IDL meshes arrive "exploded" (3 unshared
    vertices per triangle, an IDL rendering workaround), so without it the slice cut yields
    disconnected segments and the shading is faceted. Normals are always computed (the meshes
    carry none).
    """
    if pd is None or pd.GetNumberOfCells() == 0:
        return None
    src = pd
    if weld:
        clean = vtk.vtkCleanPolyData()
        clean.SetInputData(src)
        clean.PointMergingOn()
        clean.Update()
        src = clean.GetOutput()

    tri = vtk.vtkTriangleFilter()       # vtkTubeFilter emits strips; the blob is triangles
    tri.SetInputData(src)
    tri.Update()

    normals = vtk.vtkPolyDataNormals()
    normals.SetInputData(tri.GetOutput())
    normals.SplittingOff()
    normals.ConsistencyOn()
    normals.Update()
    out = normals.GetOutput()

    n_pts = out.GetNumberOfPoints()
    if n_pts == 0:
        return None
    pts = numpy_support.vtk_to_numpy(out.GetPoints().GetData()).astype("<f4", copy=False)
    nrm = numpy_support.vtk_to_numpy(out.GetPointData().GetNormals()).astype("<f4", copy=False)
    polys = numpy_support.vtk_to_numpy(out.GetPolys().GetData())    # [3,i,j,k, 3,...]
    tris = polys.reshape(-1, 4)[:, 1:4].astype("<u4", copy=False)
    body = (np.ascontiguousarray(pts).tobytes()
            + np.ascontiguousarray(nrm).tobytes()
            + np.ascontiguousarray(tris).tobytes())
    return {"blob": body, "n_points": int(n_pts), "n_tris": int(len(tris))}
