"""GET /config, GET /openable — what the browser needs to know about THIS server's filesystem.

The load controls take a server path (the desktop opens a native file dialog; the web has no
equivalent for a file already on the server, so you type its path). Those boxes used to open
pre-filled with constants baked into the bundle — paths on one developer's machine, dead
everywhere else. They come from here instead, so the same build is correct on any host.

``WEBCIP_DATA_ROOT`` is the deploy-time setting: where cases are kept. It may name several
directories, separated by ``:``. ``/openable`` scans them for everything that can be opened
WITHOUT running the pipeline — finished case folders, plans and data blocks — so the browser can
offer a list instead of asking the user to remember a path.
"""
from __future__ import annotations

import os

from fastapi import APIRouter

router = APIRouter()

# Where cases live on this server. Several roots may be given, ':'-separated. Defaults to the
# repo's own uploads folder, so a fresh checkout with no configuration still points somewhere real.
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_ROOTS = [p for p in os.environ.get(
    "WEBCIP_DATA_ROOT", os.path.join(_REPO, "uploads")).split(os.pathsep) if p]
DATA_ROOT = DATA_ROOTS[0] if DATA_ROOTS else ""

# Pre-filled paths for the load boxes. Absolute values win; relative ones resolve under
# DATA_ROOT. Empty means "no default" — the box opens blank, which is right for a server that
# has no sample data rather than pointing at a file that isn't there.
_DEFAULTS = {
    "image": os.environ.get("WEBCIP_DEFAULT_IMAGE", ""),
    "plan": os.environ.get("WEBCIP_DEFAULT_PLAN", ""),
    "cdb": os.environ.get("WEBCIP_DEFAULT_CDB", ""),
    "case": os.environ.get("WEBCIP_DEFAULT_CASE", ""),
}

# A result folder is recognised by the file the case loader cannot work without.
_CASE_MARKER = "meta.json"
# A pipeline run is recognised by the segmentation output — the minimum backend/jobfolder.py
# needs. A run that got no further than the atlas step has nothing to show and is not listed.
_JOB_MARKER = "cip_preseg.out"
_MAX_DEPTH = 2          # roots are shallow by convention; do not walk a whole filesystem


def _job_root() -> str:
    """Where the tools write their runs — always worth listing, whatever the data roots say."""
    try:
        from pv_core.tools import jobs as tool_jobs
        return tool_jobs.jobs_root()
    except Exception:  # noqa: BLE001
        return ""


_ROOTS_TO_SCAN = DATA_ROOTS + [r for r in (_job_root(),) if r and r not in DATA_ROOTS]


def _resolve(value: str) -> str:
    if not value:
        return ""
    return value if os.path.isabs(value) else os.path.join(DATA_ROOT, value)


@router.get("/config")
def config() -> dict:
    """Server-side defaults for the load controls."""
    return {
        "dataRoot": DATA_ROOT,
        "dataRoots": DATA_ROOTS,
        "defaults": {k: _resolve(v) for k, v in _DEFAULTS.items()},
    }


def _scan(root: str, depth: int, cases: list, plans: list, cdbs: list, jobs: list) -> None:
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return                                  # unreadable root: report nothing, not an error
    for e in entries:
        if e.name.startswith("."):
            continue
        if e.is_dir():
            if os.path.isfile(os.path.join(e.path, _CASE_MARKER)):
                cases.append({"name": e.name, "path": e.path})
            elif os.path.isfile(os.path.join(e.path, _JOB_MARKER)):
                jobs.append({"name": e.name, "path": e.path})
            elif depth < _MAX_DEPTH:
                _scan(e.path, depth + 1, cases, plans, cdbs, jobs)
        elif e.is_file():
            low = e.name.lower()
            if low.endswith((".pwi", ".pws")):
                plans.append({"name": e.name, "path": e.path})
            elif low.endswith(".cdb"):
                cdbs.append({"name": e.name, "path": e.path})


@router.get("/openable")
def openable() -> dict:
    """Everything under the data roots that can be displayed without running the pipeline:
    finished case folders, saved plans, and postop data blocks."""
    cases: list = []
    plans: list = []
    cdbs: list = []
    jobs: list = []
    for root in _ROOTS_TO_SCAN:
        _scan(root, 0, cases, plans, cdbs, jobs)
    jobs.sort(key=lambda j: j["name"], reverse=True)      # newest run first (timestamp names)
    return {"roots": _ROOTS_TO_SCAN, "cases": cases, "plans": plans, "cdbs": cdbs, "jobs": jobs}
