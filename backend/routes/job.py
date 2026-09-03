"""POST /job — reopen a pipeline run from its output folder.

A run's result otherwise lives only in the server's memory, so restarting the backend loses it
and there is no way back to a result short of running the pipeline again. The tool outputs are
still on disk under ``<pypv>/jobs/cip/<timestamp>/``; this rebuilds the scene from them.

The payload is POST /cdb's, and it is registered in the same registry, so the mesh / graph / MIP
routes and the whole browser display path serve it unchanged.
"""
from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import jobfolder
from ..result import cdb_payload
from . import cdb

router = APIRouter()


class JobRequest(BaseModel):
    folder: str


@router.post("/job")
def load_job(req: JobRequest) -> dict:
    """Rebuild and register a past run. Read-only: it never touches the workflow session, so
    reviewing an old result cannot disturb work in progress."""
    folder = req.folder.strip()
    if not folder:
        raise HTTPException(status_code=422, detail="no folder given")
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail=f"not a folder: {folder}")
    try:
        run, name = jobfolder.load(folder)
    except jobfolder.JobFolderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"could not read the run:\n{exc}") from exc

    data = cdb_payload(run, uuid.uuid4().hex[:12], name, path=folder)
    cdb.register(data, run)
    return data
