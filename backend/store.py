"""In-memory image store: loaded volumes keyed by the pv_core Image id.

The backend is a one-time decoder — it loads a file with pv_core, wraps it in a
pv_core.image.Image (which computes all geometry + default window/level), and holds
it so the browser can fetch geometry metadata and the raw pixel buffer. All rendering
happens client-side; nothing here renders or interpolates.
"""
from __future__ import annotations

import os

import numpy as np
import SimpleITK as sitk

from . import pvcore_path  # noqa: F401  (sets sys.path for pv_core)
from pv_core import imaging
from pv_core.image import Image

_STORE: dict[str, Image] = {}


def put(img: Image) -> Image:
    """Cache an already-constructed Image (e.g. one restored by workspace.load_workspace,
    which has its display + registration state applied already)."""
    _STORE[img.id] = img
    return img


def load_path(path: str, name: str | None = None, role: str = "") -> Image:
    """Load a DICOM folder or image file via pv_core and cache the Image.

    `role` is the workflow slot ('preop' / 'postop' / 'synthetic') the processing steps key
    off; '' is a plain scan. pv_core keeps identity in three separate fields — `display_name`
    (what the UI shows), `role`, and `source['name']` (what it is called at its origin).
    """
    sitk_img = imaging.load_volume(path)
    img = Image(sitk_img, display_name=name or path.rstrip("/").split("/")[-1])
    img.source = {"type": "file", "path": path,
                  "name": os.path.basename(path.rstrip("/"))}
    if role:
        img.role = role
    return put(img)


def get(image_id: str) -> Image | None:
    return _STORE.get(image_id)


def all_images() -> list[Image]:
    return list(_STORE.values())


def remove(image_id: str) -> bool:
    return _STORE.pop(image_id, None) is not None


# --- serialization helpers ------------------------------------------------

def _p(img: Image, key: str) -> str:
    return str((getattr(img, "patient", None) or {}).get(key, "") or "")


def geometry_dict(img: Image) -> dict:
    """The geometry + display defaults the TS core needs to reconstruct the Image.

    Mirrors the fields pv_core.image.Image computes (size, spacing, center_index,
    center_phys, origin_phys, snapped direction) plus default window/level and
    intensity range. Direction is the axis-snapped 3x3 used by the reslice math.
    """
    arr = sitk.GetArrayViewFromImage(img.sitk)  # (z, y, x)
    return {
        "id": img.id,
        "name": img.display_name,
        "role": getattr(img, "role", "") or "",
        "size": [int(v) for v in img.sitk.GetSize()],          # (x, y, z)
        "spacing": [float(v) for v in img.spacing],
        "center_index": [float(v) for v in img.center_index],
        "center_phys": [float(v) for v in img.center_phys],
        "origin_phys": [float(v) for v in img.origin_phys],
        "direction": [float(v) for v in img.direction.reshape(-1)],  # snapped 3x3 row-major
        "raw_direction": [float(v) for v in img.sitk.GetDirection()],  # as-stored 3x3
        # A .cdb's images are CROPS that declare their FULL geometry (Image.set_cropped_geometry):
        # `size` above is the stored crop, while center_index/direction describe the full grid, so
        # meshes and electrodes place in the full frame. `crop_origin` is the crop's first voxel in
        # that grid — what pv_core's `vox_matrix` applies when sampling. The browser needs it to
        # place the texture; [0,0,0] for a normal, uncropped image.
        "full_size": [int(v) for v in getattr(img, "full_size", img.sitk.GetSize())],
        "crop_origin": [float(-v) for v in np.asarray(img.vox_matrix, float)[:3, 3]],
        # global-world -> image-world (base placement composed with the registration chain).
        # Identity for a plain file load and for an unregistered plan, but NOT for a .cdb: its
        # preop/postop pair is re-framed onto the atlas (cdb_scene -> reorient.reframe_scene_to_atlas),
        # so without this the CT draws offset from the structures, which are baked to global world.
        "world_matrix": [float(v) for v in np.asarray(img.world_matrix, float).reshape(-1)],
        "orientation_label": img.orientation_label,
        "value_min": float(img.value_min),
        "value_max": float(img.value_max),
        "level": float(img.level),
        "window": float(img.window),
        "header_level": None if img.header_level is None else float(img.header_level),
        "header_window": None if img.header_window is None else float(img.header_window),
        "dtype": _dtype_name(arr.dtype),
        "scalar_size_bytes": int(arr.dtype.itemsize),
        # Per-image display state. Defaults for a freshly loaded file; for an Image restored
        # from a plan these are what workspace.apply_record put back (pv_core/workspace.py).
        "interp": img.interp,
        "colormap_index": int(img.colormap_index),
        "crop_box": None if img.crop_box is None else [int(v) for v in img.crop_box],
        "show_cropped": bool(img.show_cropped),
        "fg_window": [float(v) for v in img.fg_window],
        "surface_threshold": [float(v) for v in img.surface_threshold],
        "surface_style": img.surface_style,
        "render3d_mode": img.render3d_mode,
        # pv_core consolidated the per-field patient attributes into one dict
        # (image.py: `self.patient = _header.get_patient(...)`, keys
        # {mrn,name,dob,sex,eid,institution,group}). The wire keeps `id` for the browser.
        "patient": {
            "id": _p(img, "mrn"),
            "name": _p(img, "name"),
            "dob": _p(img, "dob"),
            "sex": _p(img, "sex"),
            "institution": _p(img, "institution"),
        },
    }


def raw_bytes(img: Image) -> tuple[bytes, str]:
    """The pixel buffer as contiguous little-endian bytes, x-fastest (VTK order).

    SimpleITK's array is (z, y, x); a C-order ravel is x-fastest, which is exactly
    what vtkImageData with dims (x, y, z) expects for its point scalars.
    """
    arr = sitk.GetArrayFromImage(img.sitk)             # (z, y, x)
    arr = np.ascontiguousarray(arr)
    if arr.dtype.byteorder == ">":
        arr = arr.astype(arr.dtype.newbyteorder("<"))
    return arr.tobytes(order="C"), _dtype_name(arr.dtype)


_DTYPE_NAMES = {
    np.dtype("int8"): "Int8",
    np.dtype("uint8"): "Uint8",
    np.dtype("int16"): "Int16",
    np.dtype("uint16"): "Uint16",
    np.dtype("int32"): "Int32",
    np.dtype("uint32"): "Uint32",
    np.dtype("float32"): "Float32",
    np.dtype("float64"): "Float64",
}


def _dtype_name(dt) -> str:
    """A JS TypedArray-compatible dtype name (e.g. 'Int16' -> Int16Array)."""
    return _DTYPE_NAMES.get(np.dtype(dt), "Float32")
