"""GET /browse — list a server directory, so the browser can offer a real file/folder picker.

The desktop opens a native file dialog. A web page cannot: its own picker returns file CONTENT,
which is right for a scan on your laptop but useless for the things that are already here — a
400 MB CT, or a pipeline run whose folder holds gigabytes of tool output. So the picker browses
the SERVER's filesystem and returns a path.

POST /upload-file is the other half: it stores a file the browser did upload and returns its
path, so both routes end at "a path on this server" and everything downstream is one code path.
"""
from __future__ import annotations

import os
import shutil

from fastapi import APIRouter, Form, HTTPException, UploadFile

from .config import _ROOTS_TO_SCAN
from .load import UPLOAD_DIR, _safe_name

router = APIRouter()

# What each picker asks for. Directories are always listed (you navigate through them, and some
# selections ARE directories — a DICOM series, a pipeline run).
_KNOWN_EXT = {
    "image": (".nii", ".nii.gz", ".nrrd", ".mha", ".mhd", ".dcm", ".img", ".hdr"),
    "cdb": (".cdb", ".pwi", ".pws"),
    "any": (),
}

# A folder worth offering as a selection in its own right, and why — shown beside its name so
# you can tell a pipeline run from an ordinary directory without opening it.
_FOLDER_KINDS = (("cip_preseg.out", "run"), ("meta.json", "case"))


def _folder_kind(path: str) -> str:
    for marker, kind in _FOLDER_KINDS:
        if os.path.isfile(os.path.join(path, marker)):
            return kind
    return ""


@router.get("/browse")
def browse(path: str = "", kind: str = "image") -> dict:
    """One directory's contents. `kind` selects the extension filter ('image', 'cdb', 'any').

    With no `path`, returns the configured roots as the starting points rather than `/` — the
    places this server actually keeps data.
    """
    exts = _KNOWN_EXT.get(kind, _KNOWN_EXT["image"])
    if not path:
        return {
            "path": "", "parent": "", "roots": _ROOTS_TO_SCAN,
            "entries": [{"name": r, "path": r, "dir": True, "kind": _folder_kind(r)}
                        for r in _ROOTS_TO_SCAN if os.path.isdir(r)],
        }
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail=f"not a directory: {path}")

    entries = []
    try:
        for name in sorted(os.listdir(path)):
            if name.startswith("."):
                continue
            full = os.path.join(path, name)
            if os.path.isdir(full):
                entries.append({"name": name, "path": full, "dir": True,
                                "kind": _folder_kind(full)})
            elif not exts or name.lower().endswith(exts):
                entries.append({"name": name, "path": full, "dir": False, "kind": "",
                                "size": os.path.getsize(full)})
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    return {"path": path, "parent": os.path.dirname(path.rstrip("/")) or "/",
            "roots": _ROOTS_TO_SCAN, "entries": entries}


@router.post("/upload-file")
async def upload_file(file: UploadFile, name: str = Form("")) -> dict:
    """Store an uploaded file and return its path on this server — nothing else.

    Deliberately dumber than /upload, which also decodes the file as an image and adds it to the
    workflow session: a .cdb is neither. The caller then opens the returned path with whichever
    loader suits it, so browsing and uploading converge on the same next step.
    """
    original = os.path.basename(file.filename or "upload")
    safe = _safe_name(name or original)
    if not safe:
        raise HTTPException(status_code=422, detail="unusable filename")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, safe)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(UPLOAD_DIR):
        raise HTTPException(status_code=422, detail="invalid filename")
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f, 1 << 20)
    return {"path": path, "name": safe}
