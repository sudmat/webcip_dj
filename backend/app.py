"""WebCIP backend — a thin one-time file-decoder over pv_core.

Endpoints (under /api) load a DICOM folder / NIfTI / raw file with pv_core and hand
the browser a plain pixel buffer + geometry JSON. It never renders or interpolates;
all MPR / volume rendering happens client-side in VTK.js.

Dev:  conda run -n webcip uvicorn backend.app:app --reload --port 8011
      (frontend on `npm run dev`, which proxies /api here)
Prod: build the frontend (`npm run build`) and this also serves frontend/dist at /.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import hold as _hold
from .routes import (auto, browse, case, cdb, colormaps, config, header, job, load,
                     plan, surface, volume)

app = FastAPI(title="WebCIP backend", version="0.1")

# Name the per-project folder external tool runs write into (<install>/jobs/cip/), as the
# desktop does at startup — raw images, configs and tool outputs land there for inspection.
from . import pvcore_path  # noqa: E402,F401  (sets sys.path for pv_core)
from pv_core.tools import jobs as _tool_jobs  # noqa: E402

_tool_jobs.set_app("cip")
# NO prune() here, deliberately. The desktop calls it at startup, but the desktop starts once a
# session — a server restarts constantly (every deploy, every crash, every code change), and
# prune() is COUNT-based: it keeps the 5 most recent and deletes the rest. Calling it on each
# start quietly destroyed a day of tool output on the dev box. Reclaiming that space is the
# deploy/webcip-prune.timer's job, which is age-based (7 days) and therefore predictable.

# Identify the browser (backend/hold.py) so the single shared workspace can name its holder.
app.middleware("http")(_hold.attach_sid)

# A plan's CT is ~115 MB of raw int16 over /volume; CT voxels deflate to roughly half that
# (the .pwi stores the same image as a 65 MB .nii.gz). Level 1 keeps the CPU cost negligible.
app.add_middleware(GZipMiddleware, minimum_size=1 << 20, compresslevel=1)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev; a research tool on a trusted network
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# All data endpoints live under /api so the same paths work in dev (Vite proxy) and
# prod (mounted). The browser always calls /api/*.
api = APIRouter(prefix="/api")
api.include_router(config.router)
api.include_router(load.router)
api.include_router(volume.router)
api.include_router(header.router)
api.include_router(browse.router)
api.include_router(colormaps.router)
api.include_router(surface.router)
api.include_router(case.router)
api.include_router(plan.router)
api.include_router(cdb.router)
api.include_router(job.router)
api.include_router(auto.router)


@api.get("/health")
def health() -> dict:
    return {"ok": True}


app.include_router(api)

# Serve the built SPA at / when present (single-origin prod / end-to-end testing).
_DIST = os.path.join(os.path.dirname(__file__), os.pardir, "frontend", "dist")
if os.path.isdir(_DIST):
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="spa")
