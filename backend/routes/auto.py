"""POST /auto/start + the run's progress and result — the web's 'Auto process …'.

The pipeline itself is backend/autoprocess.py (a headless port of projects/cip/auto_process.py);
this is the transport. A run takes minutes, so the request only STARTS it and the browser
follows over SSE, exactly as the desktop's dialog follows its progress sink.

The finished run is served in the same shape as POST /cdb, so the browser reuses the .cdb
display path (structures + the electrode dock) rather than growing a second one.
"""
from __future__ import annotations

import json
import queue

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import autoprocess, jobs, store
from ..hold import require_hold, sid_of
from .. import workflow as wf
from . import cdb
from ..pvcore_path import WEBCIP_SRC  # noqa: F401  (sets sys.path for pv_core)

router = APIRouter()

_TICK = 0.5   # seconds between keep-alive snapshots while a step is running


class AutoStartRequest(BaseModel):
    side: str                 # 'left' | 'right'
    electrodeId: int
    # Proceed even though another browser holds the workspace (the banner's "Take over").
    takeover: bool = False


@router.get("/auto/electrodes")
def electrodes() -> dict:
    """The Electrode-type dropdown's options (every model in the config)."""
    return {"electrodes": autoprocess.electrode_options()}


@router.post("/auto/start")
def start(req: AutoStartRequest, request: Request) -> dict:
    """Run every step in sequence over the workflow session's images."""
    require_hold(request, req.takeover)
    if req.side not in ("left", "right"):
        raise HTTPException(status_code=422, detail="side must be 'left' or 'right'")
    sess = wf.session()
    if not any(getattr(im, "role", "") in ("preop", "synthetic") for im in sess.run.images):
        raise HTTPException(status_code=422,
                            detail="load a CT as the preop before running Auto process")
    sess.set_side(req.side)
    sess.run.electrode_id = int(req.electrodeId)
    try:
        job = jobs.start(sess.run, autoprocess.plan_steps(sess.run.images))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return job.snapshot()


class StepRequest(BaseModel):
    """A single numbered step. `electrodeId` applies to 'electrodes' only."""
    electrodeId: int | None = None
    takeover: bool = False


@router.post("/step/{key}")
def run_step(key: str, req: StepRequest, request: Request) -> dict:
    """Run ONE workflow step against the session — the manual counterpart of /auto/start.

    It is the same machinery with a one-entry step list, so a manual step reports progress and
    lands its result exactly as an Auto-process step does.
    """
    require_hold(request, req.takeover)
    sess = wf.session()
    labels = _STEP_LABELS
    if key not in autoprocess.RUNNERS:
        raise HTTPException(status_code=404, detail=f"unknown step: {key}")
    if not sess.state()["available"].get(_GATE.get(key, key), True):
        raise HTTPException(status_code=409,
                            detail=f"'{labels.get(key, key)}' is not available yet")
    if req.electrodeId is not None:
        sess.run.electrode_id = int(req.electrodeId)
    try:
        job = jobs.start(sess.run, [(key, labels.get(key, key))])
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return job.snapshot()


# The runner keys that share a numbered step's gate ('erase' is inside Segment structures).
_GATE = {"erase": "segment"}

# Every runner's label. Not `plan_steps`, which lists only the branch the loaded images imply —
# a manual step is run on its own and still needs a name to report under.
_STEP_LABELS = {
    "atlas": "Register preop to atlas",
    "erase": "Erase implant",
    "segment": "Segment structures",
    "postop": "Register postop to preop",
    "electrodes": "Search for electrodes",
}


@router.get("/workflow")
def workflow_state(request: Request) -> dict:
    """The workflow column's state: banner, images + roles, per-step gating, which results exist,
    and who holds the workspace. Read-only, so it never claims — but a holder's own polling keeps
    their hold alive while they read a result."""
    sid = sid_of(request)
    sess = wf.session()
    sess.touch(sid)
    return sess.state(sid)


class ClearRequest(BaseModel):
    takeover: bool = False


class SideRequest(BaseModel):
    side: str
    takeover: bool = False


@router.post("/workflow/side")
def set_side(req: SideRequest, request: Request) -> dict:
    """Step 2. Switching to the other ear cancels the planning work and keeps the images (the
    desktop warns first; the browser owns that confirmation)."""
    sid = require_hold(request, req.takeover)
    if req.side not in ("left", "right"):
        raise HTTPException(status_code=422, detail="side must be 'left' or 'right'")
    wf.session().set_side(req.side)
    return wf.session().state(sid)


@router.post("/workflow/claim")
def claim(request: Request, req: ClearRequest | None = None) -> dict:
    """Take the workspace (the banner's "Take over"), or just refresh an existing hold.

    A separate route so the browser can claim deliberately, rather than discovering the conflict
    by having a real action refused.
    """
    sid = require_hold(request, bool(req and req.takeover))
    return wf.session().state(sid)


@router.post("/workflow/release")
def release(request: Request) -> dict:
    """Hand the workspace back. A script or a page that is done should call this instead of
    leaving everyone else to wait out the idle timer."""
    sid = sid_of(request)
    wf.session().release(sid)
    return wf.session().state(sid)


@router.post("/workflow/clear")
def clear_workspace(request: Request, req: ClearRequest | None = None) -> dict:
    """The Load menu's 'Clear workspace' — every image and all planning work."""
    sid = require_hold(request, bool(req and req.takeover))
    wf.session().clear()
    return wf.session().state(sid)


@router.post("/workflow/clear-structures")
def clear_structures(request: Request, req: ClearRequest | None = None) -> dict:
    """Step 4's 'Clear all'."""
    sid = require_hold(request, bool(req and req.takeover))
    wf.session().clear_structures()
    return wf.session().state(sid)


@router.post("/workflow/clear-electrodes")
def clear_electrodes(request: Request, req: ClearRequest | None = None) -> dict:
    """Step 6's 'Clear all'."""
    sid = require_hold(request, bool(req and req.takeover))
    wf.session().clear_electrodes()
    return wf.session().state(sid)


@router.get("/auto/{job_id}")
def status(job_id: str) -> dict:
    """The current state — lets a reloaded page rejoin a running run."""
    return _get(job_id).snapshot()


@router.get("/auto/{job_id}/events")
def events(job_id: str) -> StreamingResponse:
    """Server-sent events: one per state change, plus a tick while a step runs so the elapsed
    time keeps moving without the client having to poll."""
    job = _get(job_id)

    def stream():
        q = job.subscribe()
        try:
            while True:
                try:
                    snap = q.get(timeout=_TICK)
                except queue.Empty:
                    job._tick()                      # keep the running row's clock live
                    snap = job.snapshot()
                yield f"data: {json.dumps(snap)}\n\n"
                if snap.get("finished"):
                    break
        finally:
            job.unsubscribe(q)

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-store",
                 "X-Accel-Buffering": "no",       # don't let a proxy buffer the stream
                 # Starlette's GZipMiddleware skips a response that already declares an
                 # encoding. Without this it wraps the stream and events arrive in batches,
                 # which is precisely what a progress feed must not do.
                 "Content-Encoding": "identity"})


@router.get("/auto/{job_id}/result")
def result(job_id: str) -> dict:
    """The run's CURRENT result, in POST /cdb's shape — available after any step, not only at the
    end, so the browser can show each step's output as it lands (the desktop pushes straight into
    its live scene; see Job.revision).

    The run is also REGISTERED in the cdb route's registry under the job id, so
    ``/cdb/{id}/mesh``, ``/cdb/{id}/graph`` and ``/cdb/{id}/mip`` serve it unchanged — the
    browser then displays an auto-process result through exactly the path a loaded .cdb uses,
    with no duplicate endpoints and no second display path to keep in step.
    """
    job = _get(job_id)
    if not job.revision:
        raise HTTPException(status_code=409, detail="no step has completed yet")
    out = job.result()
    cdb.register(out, job.run)
    return out


def _get(job_id: str) -> jobs.Job:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    return job
