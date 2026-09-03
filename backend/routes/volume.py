"""GET /volume/{id} — the raw pixel buffer (little-endian, x-fastest) for VTK.js."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from .. import store

router = APIRouter()


@router.get("/volume/{image_id}")
def volume(image_id: str) -> Response:
    img = store.get(image_id)
    if img is None:
        raise HTTPException(status_code=404, detail="image not loaded")
    data, dtype = store.raw_bytes(img)
    sx, sy, sz = (int(v) for v in img.sitk.GetSize())
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "X-Dtype": dtype,               # e.g. "Int16" -> Int16Array
            "X-Dims": f"{sx},{sy},{sz}",    # (x, y, z)
            "Cache-Control": "no-store",
            # Declaring an encoding makes GZipMiddleware skip this response, which is the
            # point: MEASURED on a 419 MB CT, deflate took 13.4 s to save 27% (CT voxels are
            # noisy and compress badly), turning a 0.8 s transfer into 14.2 s. The middleware
            # earns its keep on JSON, not on raw voxels.
            "Content-Encoding": "identity",
        },
    )
