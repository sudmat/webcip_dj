"""POST /load — decode a file/folder into a cached volume; return geometry metadata.
POST /upload — same, from a browser-uploaded file (for testing without server paths).

Uploads are written flat under <repo>/uploads/ (see UPLOAD_DIR) as <case>_<role><ext>,
replacing any previous upload for that case + role."""
from __future__ import annotations

import os
import re
import shutil

from fastapi import APIRouter, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from .. import store
from .. import workflow as wf
from ..hold import require_hold

router = APIRouter()


class LoadRequest(BaseModel):
    path: str
    name: str | None = None
    # The workflow slot this image fills ('preop' / 'postop'); '' is a plain scan. The
    # processing steps key off it (backend/autoprocess.py), so it is set at load time.
    role: str = ""
    # Proceed even though another browser holds the workspace (the banner's "Take over").
    takeover: bool = False


# Uploaded volumes land in the project, not /tmp: they are hundreds of MB each, they must stay
# readable for as long as the image is loaded, and a system /tmp sweeper pulling one out from
# under a live session is not a failure mode worth having. Override with WEBCIP_UPLOAD_DIR.
# Files are named <case>_<role><ext> — flat, deterministic, and overwritten on re-upload.
UPLOAD_DIR = os.environ.get(
    "WEBCIP_UPLOAD_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                 "uploads"),
)


# Extensions that are two parts — splitext would otherwise call ".nii.gz" just ".gz".
_DOUBLE_EXT = (".nii.gz", ".img.gz", ".tar.gz")


def _safe_name(text: str) -> str:
    """A case name reduced to something safe to put in a path.

    This value comes from the browser and BECOMES A FILENAME, so it is filtered to
    `[A-Za-z0-9._-]` rather than merely escaped — that drops `/`, `\\` and `..` outright, so no
    input can climb out of UPLOAD_DIR. Leading dots go too (no hidden files).
    """
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(text or "")).strip("-.")
    return cleaned[:64]


def _stem(filename: str) -> str:
    """The filename without its extension ('PID_1941_pre.nii.gz' -> 'PID_1941_pre')."""
    return filename[: len(filename) - len(_extension(filename))] if _extension(filename) else filename


def _extension(filename: str) -> str:
    lower = filename.lower()
    for ext in _DOUBLE_EXT:
        if lower.endswith(ext):
            return filename[-len(ext):]
    return os.path.splitext(filename)[1]


@router.post("/upload")
async def upload(request: Request, file: UploadFile, role: str = Form(""),
                 case: str = Form(""), takeover: bool = Form(False)) -> dict:
    """Load a browser-uploaded file, stored as ``<case>_<role><ext>`` directly in UPLOAD_DIR.

    Flat, deterministic and overwriting by design: re-uploading the same case + role REPLACES the
    file rather than accumulating copies, so the folder stays one file per case per role. `role`
    matches /load's — without it an uploaded CT could never be the preop.
    """
    require_hold(request, takeover)
    original = os.path.basename(file.filename or "upload")
    # A case name is optional: with none, the uploaded file's own stem names it. Requiring one
    # made "Load preop CT" refuse to open a file dialog until an unrelated box was filled in,
    # which is friction for no benefit — the point of the name is a predictable filename, and
    # the source filename is already predictable.
    case_name = _safe_name(case) or _safe_name(_stem(original)) or "case"
    slot = _safe_name(role) or "image"
    name = f"{case_name}_{slot}{_extension(original)}"

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, name)
    # Belt and braces: the filter above cannot produce a separator, but a path that escaped
    # UPLOAD_DIR would be worth catching loudly rather than writing.
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(UPLOAD_DIR):
        raise HTTPException(status_code=422, detail="invalid case name")

    # Copied in 1 MiB chunks, NOT `f.write(await file.read())`: a CT is 350 MB and reading it
    # whole put all of it in RAM at once, on top of the copy Starlette has already spooled.
    with open(path, "wb") as f:                     # truncates an existing file — replace, not add
        shutil.copyfileobj(file.file, f, 1 << 20)
    try:
        img = store.load_path(path, name, role=role)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"load failed: {exc}") from exc
    wf.session().add_image(img, role)
    return store.geometry_dict(img)


class RoleRequest(BaseModel):
    role: str
    takeover: bool = False


@router.put("/images/{image_id}/role")
def set_role(image_id: str, req: RoleRequest, request: Request) -> dict:
    """Change a loaded image's workflow slot. The backend store is what the processing steps
    read, so a role has to be changed HERE, not just in the browser — this lets a mis-loaded
    image be corrected without re-uploading it."""
    require_hold(request, req.takeover)
    img = store.get(image_id)
    if img is None:
        raise HTTPException(status_code=404, detail="image not loaded")
    if req.role not in ("", "preop", "postop", "synthetic"):
        raise HTTPException(status_code=422, detail=f"unknown role: {req.role}")
    img.role = req.role
    return store.geometry_dict(img)


@router.post("/load")
def load(req: LoadRequest, request: Request) -> dict:
    require_hold(request, req.takeover)
    if not os.path.exists(req.path):
        raise HTTPException(status_code=404, detail=f"path not found: {req.path}")
    try:
        img = store.load_path(req.path, req.name, role=req.role)
    except Exception as exc:  # decode failures surface to the browser
        raise HTTPException(status_code=422, detail=f"load failed: {exc}") from exc
    # The workflow session owns the loaded set (and applies the Load-file role rules: a preop
    # clears the workspace, a postop replaces the previous one).
    wf.session().add_image(img, req.role)
    return store.geometry_dict(img)


@router.get("/images")
def images() -> list[dict]:
    return [store.geometry_dict(img) for img in store.all_images()]


@router.delete("/images/{image_id}")
def remove(image_id: str) -> dict:
    return {"removed": store.remove(image_id)}
