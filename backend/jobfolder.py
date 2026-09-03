"""Rebuild a displayable scene from a pipeline job folder.

Every tool run leaves one of these behind (``<pypv>/jobs/cip/<timestamp>/``): the raw images it
was fed, the config that described them, and the outputs it produced. That is enough to show the
result again without re-running anything — which is otherwise impossible, because the pipeline's
result lives only in the server's memory until the process restarts.

**Why this is faithful and not an approximation.** The raws are headerless, and the config records
only dims, voxel size and orientation codes — not the DICOM origin, so the reconstructed image
sits at an arbitrary absolute position. That turns out not to matter: the meshes are stored in the
PATIENT frame (R/P/I from the LAS corner), and ``segmentation._voi_structures`` maps them with
``image.world_matrix @ inv(image.mat_world_to("patient"))`` — a composition in which the world
matrix cancels, because "patient is intrinsic to the grid". The placement therefore depends only
on the three things the config does record. What is lost is the ability to line the result up
against the ORIGINAL scan file; everything within the job stays exactly where the tools put it.
"""
from __future__ import annotations

import os
import re

import numpy as np

from . import autoprocess
from . import pvcore_path  # noqa: F401  (sets sys.path for pv_core + projects)


class JobFolderError(RuntimeError):
    """The folder is not a usable job output; the message is shown to the user."""


# The configs the tools are handed. They use two dialects: the electrode search names both
# images ("[Preop Dimensions]" …), while the segmentation names only one ("[Image Dimensions]",
# "[Voxel Size]"). A run may have either or both, so both are read.
_POSTSEG_IN = "cip_postseg.in"
_PRESEG_IN = "cip_preseg.in"


def _parse_config(path: str) -> dict:
    """The ``[Section]``/value pairs from a tool config. Values are the lines after the header,
    up to the next header; comments after '//' are stripped."""
    out: dict[str, list[str]] = {}
    key = None
    with open(path, "rb") as f:
        head = f.read(65536).decode("latin-1", "replace")
    for line in head.splitlines():
        m = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
        if m:
            key = m.group(1)
            out[key] = []
        elif key is not None:
            text = line.split("//")[0].strip()
            if text:
                out[key].append(text)
    return out


def _triplet(cfg: dict, key: str, cast):
    try:
        vals = [cast(v) for v in cfg[key][0].split()]
    except (KeyError, IndexError, ValueError):
        return None
    return vals if len(vals) == 3 else None


def _image_spec(cfg: dict, folder: str, which: str) -> dict | None:
    """``{path, dims, voxsize, orient}`` for one image the config describes, or None.

    `which` is 'Preop' / 'Postop' (the electrode-search dialect) or 'Image' (the segmentation
    dialect, whose voxel size and orientation keys carry no prefix). The raw's name is taken
    from the config rather than assumed — the tools do not use one convention.
    """
    prefix = "" if which == "Image" else f"{which} "
    dims = _triplet(cfg, f"{which} Dimensions", int)
    voxsize = _triplet(cfg, f"{prefix}Voxel Size", float)
    orient = _triplet(cfg, f"{prefix}Orientation", int)
    if not (dims and voxsize and orient):
        return None
    declared = (cfg.get(f"{which} Filename") or [""])[0]
    path = os.path.join(folder, os.path.basename(declared.replace("\\", "/")))
    if not os.path.isfile(path):
        return None                              # config without its raw: nothing to read
    return {"path": path, "dims": dims, "voxsize": voxsize, "orient": orient}


def _read_raw(geo: dict, name: str, role: str):
    """A headerless little-endian int16 raw (the ``.im`` the tools are fed) back into an Image.

    The inverse of ``pv_core.tools.raw_image.write_raw_int16``, which has no reader of its own.
    """
    import SimpleITK as sitk
    from pv_core import geometry as pv_geo
    from pv_core.image import Image

    path = geo["path"]
    nx, ny, nz = geo["dims"]
    expect = nx * ny * nz * 2
    actual = os.path.getsize(path)
    if actual != expect:
        raise JobFolderError(
            f"{os.path.basename(path)} is {actual} bytes but its config declares "
            f"{nx}x{ny}x{nz} int16 = {expect}. The folder's config and raw do not match.")

    arr = np.fromfile(path, dtype="<i2").reshape(nz, ny, nx)   # written C-order, x fastest
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing([float(v) for v in geo["voxsize"]])
    img.SetDirection(pv_geo.direction_from_ori_codes(geo["orient"]).flatten(order="F").tolist())
    # Origin is not recorded and does not affect where the meshes land (see the module docstring).
    # Centre the volume so the physical frame matches the tools' own centred convention.
    extent = [(d - 1) * s for d, s in zip(geo["dims"], geo["voxsize"])]
    img.SetOrigin([-e / 2.0 for e in extent])

    out = Image(img, name)
    out.role = role
    out.source = {"type": "job", "name": os.path.basename(path)}
    return out


def _side(cfg: dict, folder: str) -> str:
    ear = (cfg.get("Ear") or [""])[0].strip().lower()
    if ear in ("left", "right"):
        return ear
    # The atlas step names its dump per side; fall back to that.
    for name in os.listdir(folder):
        m = re.match(r"atlas_mat_preop_(left|right)\.txt$", name)
        if m:
            return m.group(1)
    raise JobFolderError("Could not tell which ear this run was for (no [Ear] in its config).")


def load(folder: str) -> tuple[autoprocess.Run, str]:
    """Rebuild a `Run` from a job folder. Returns it with a display name."""
    import projects.cip as cip
    from projects.cip import segmentation

    if not os.path.isdir(folder):
        raise JobFolderError(f"not a folder: {folder}")

    postseg_in = os.path.join(folder, _POSTSEG_IN)
    preseg_in = os.path.join(folder, _PRESEG_IN)
    cfgs = [_parse_config(p) for p in (postseg_in, preseg_in) if os.path.isfile(p)]
    if not cfgs:
        raise JobFolderError(
            f"No tool config here ({_PRESEG_IN} / {_POSTSEG_IN}), so the images cannot be read. "
            "Is this a completed run?")
    side = next((_side(c, folder) for c in cfgs if (c.get("Ear") or [""])[0].strip()),
                _side({}, folder))

    preseg = os.path.join(folder, "cip_preseg.out")
    postseg = os.path.join(folder, "cip_postseg.out")
    if not os.path.isfile(preseg):
        raise JobFolderError(
            "This run has no cip_preseg.out — the segmentation step did not finish, so there "
            "are no structures to show.")

    # --- the images -------------------------------------------------------------------
    # 'Preop' here is whatever the run treated as the preop (a synthetic, in the erase route).
    preop_spec = postop_spec = None
    for c in cfgs:
        preop_spec = preop_spec or _image_spec(c, folder, "Preop") or _image_spec(c, folder, "Image")
        postop_spec = postop_spec or _image_spec(c, folder, "Postop")

    images = []
    preop = postop = None
    if preop_spec:
        preop = _read_raw(preop_spec, cip.ROLE_DISPLAY.get("preop", "Preop CT"), "preop")
        images.append(preop)
    if postop_spec:
        postop = _read_raw(postop_spec, cip.ROLE_DISPLAY.get("postop", "Postop CT"), "postop")
        images.append(postop)
    if preop is None:
        raise JobFolderError(
            "The preop raw image this run was given is no longer in the folder, so the "
            "structures have nothing to be anchored to.")

    run = autoprocess.Run(images, side, 0)
    run.state["side"] = side
    run.state.setdefault("cip", {})["preseg_out"] = preseg

    # --- the anatomy ------------------------------------------------------------------
    try:
        structures = segmentation.load_structures(preseg, side, preop)
    except Exception as exc:  # noqa: BLE001
        raise JobFolderError(f"Could not read cip_preseg.out:\n{exc}") from exc
    if not structures:
        raise JobFolderError("cip_preseg.out contains no structures.")
    cip._add_ab_and_rw(structures, preseg, side, preop)
    run.objects.extend(structures)

    # --- the electrodes, when the run got that far ------------------------------------
    if os.path.isfile(postseg) and postop is not None:
        try:
            res = segmentation.load_postop(postseg, side, postop, preop)
        except Exception as exc:  # noqa: BLE001
            raise JobFolderError(f"Could not read cip_postseg.out:\n{exc}") from exc
        new = res.get("structures") or []
        names = {s.name for s in new}
        run.objects = [o for o in run.objects
                       if not (o.kind == "structure" and o.name in names)]
        run.objects.extend(new)
        lead = res.get("lead")
        if lead is not None:
            run.objects.append(lead)
            eid = int((lead.extra.get("cie") or {}).get("lead_type") or 0)
            run.electrode_id = eid
            run.state["cip"]["seg_electrode_id"] = eid or None

    return run, os.path.basename(os.path.normpath(folder))
