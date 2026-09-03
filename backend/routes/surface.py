"""GET /surface/{id} — isosurface mesh built with C++ vtkFlyingEdges3D (like the desktop),
streamed as a binary blob for the browser to render directly (no JS marching cubes).

The mesh is emitted in the frontend's global-world frame: the vtkImageData is placed with
the same centred geometry as the browser's volume (origin = -(D @ (spacing*centre)),
direction D), so FlyingEdges outputs world points + normals that need no client transform.
"""
from __future__ import annotations

import numpy as np
import SimpleITK as sitk
import vtk
from fastapi import APIRouter, HTTPException, Response
from vtkmodules.util import numpy_support

from .. import store

router = APIRouter()


@router.get("/surface/{image_id}")
def surface(image_id: str, iso: float | None = None, cutoff: float | None = None) -> Response:
    img = store.get(image_id)
    if img is None:
        raise HTTPException(status_code=404, detail="image not loaded")
    lo = float(iso if iso is not None else img.surface_threshold[0])
    hi = float(cutoff if cutoff is not None else img.surface_threshold[1])

    grid = _centred_grid(img)
    contour = vtk.vtkFlyingEdges3D()
    if hi > lo:
        # push voxels >= cutoff below the iso so they don't form surface (desktop behaviour)
        clamp = vtk.vtkImageThreshold()
        clamp.SetInputData(grid)
        clamp.ThresholdByUpper(hi)
        clamp.ReplaceInOn()
        clamp.SetInValue(lo - 1.0)
        clamp.ReplaceOutOff()
        contour.SetInputConnection(clamp.GetOutputPort())
    else:
        contour.SetInputData(grid)
    contour.SetValue(0, lo)
    contour.ComputeNormalsOn()
    contour.ComputeGradientsOff()
    contour.Update()
    poly = contour.GetOutput()

    n_pts = poly.GetNumberOfPoints()
    if n_pts == 0:
        return Response(b"", media_type="application/octet-stream",
                        headers={"X-NPoints": "0", "X-NTris": "0",
                                 "Content-Encoding": "identity"})
    pts = numpy_support.vtk_to_numpy(poly.GetPoints().GetData()).astype("<f4", copy=False)
    normals = numpy_support.vtk_to_numpy(poly.GetPointData().GetNormals()).astype("<f4", copy=False)
    polys = numpy_support.vtk_to_numpy(poly.GetPolys().GetData())  # [3,i,j,k, 3,...]
    tris = polys.reshape(-1, 4)[:, 1:4].astype("<u4", copy=False)

    body = pts.tobytes() + normals.tobytes() + np.ascontiguousarray(tris).tobytes()
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={"X-NPoints": str(n_pts), "X-NTris": str(len(tris)), "Cache-Control": "no-store",
                 # Same measured trade as /volume: deflate cost 13.8 s on this 451 MB mesh to
                 # save 47%. Float coordinates do not compress well enough to pay for it.
                 "Content-Encoding": "identity"},
    )


def _centred_grid(img) -> vtk.vtkImageData:
    """vtkImageData placed so index->world matches image.pixel_to_world (unregistered)."""
    arr = sitk.GetArrayFromImage(img.sitk)  # (z, y, x)
    grid = vtk.vtkImageData()
    grid.SetDimensions(*img.sitk.GetSize())
    grid.SetSpacing(*(float(s) for s in img.spacing))
    o = -(img.direction @ (img.spacing * img.center_index))
    grid.SetOrigin(*(float(v) for v in o))
    m = vtk.vtkMatrix3x3()
    m.DeepCopy([float(v) for v in img.direction.reshape(-1)])
    grid.SetDirectionMatrix(m)
    flat = np.ascontiguousarray(arr).ravel(order="C")
    grid.GetPointData().SetScalars(
        numpy_support.numpy_to_vtk(flat, deep=True,
                                   array_type=numpy_support.get_vtk_array_type(arr.dtype))
    )
    return grid
