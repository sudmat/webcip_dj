# WebCIP — web viewer

Web port of the CIP desktop planning app (PySide6 + VTK + SimpleITK). It displays saved plans
(`.pwi`) and postop data blocks (`.cdb`), and runs the processing pipeline — either unattended
(**Auto process**) or step by step through the numbered workflow column.

**Architecture.** A thin **FastAPI backend** reuses the desktop's UI-free `pv_core`
package as a *one-time file decoder* (DICOM/NIfTI/raw → pixel buffer + geometry). The
**browser** does all rendering/interaction with **VTK.js**; the small coordinate math is
ported to TypeScript. The backend never renders or interpolates. Full write-up:
[ARCHITECTURE.md](ARCHITECTURE.md).

```
frontend/   Vite + React + TS + VTK.js   (all rendering, client-side)
backend/    FastAPI over pv_core          (decode files, serve pixels + geometry, run the tools)
deploy/     systemd + Apache + deploy.sh  (see deploy/SERVER_SETUP.md)
```

The processing steps shell out to four Docker images (`cip/dq`, `cip/jn`, `cip/pcisp`,
`cip/amir`) through `pv_core.tools`; without them the app still loads and displays plans.

## Run (dev)

Backend (serves the API under `/api`):
```
cd /var/www/html/webcip
conda run -n webcip uvicorn backend.app:app --reload --port 8011
# pv_core + projects.cip are imported from $WEBCIP_SRC (default /data/mipwork/pypv)
```

Frontend (Vite dev server, proxies `/api` → backend):
```
cd frontend
npm install        # .npmrc pins legacy-peer-deps (vtk.js declares a babel peer)
npm run dev
```

> **Dev-server note:** `vite dev` uses inotify file watchers. On a box where the global
> limit is exhausted you'll see `ENOSPC: System limit for number of file watchers`.
> Fix: `sudo sysctl fs.inotify.max_user_watches=524288` (and `max_user_instances`).
> This does not affect `npm run build` or the backend.

## Opening finished work (no pipeline run)

Three kinds of saved result open directly — a plan (`.pwi`/`.pws`), a postop data block (`.cdb`),
and a result folder (the Display tab's `meta.json` + meshes + curves). Point the server at where
they live and it lists what it finds, so the load controls become pickers rather than a path you
have to remember:

```
export WEBCIP_DATA_ROOT=/var/www/html/musc-analytics/postop_data:/data/mipwork/webcip/temp
conda run -n webcip uvicorn backend.app:app --port 8011
```

`WEBCIP_DATA_ROOT` is `:`-separated and scanned two levels deep; `GET /api/openable` reports what
was found. Result folders appear in the Display tab's dropdown, plans and `.cdb`s under
**1. Load file → Open a result on this server**.

## Run (single-origin, no dev watcher)

```
cd frontend && npm run build          # emits frontend/dist
cd .. && conda run -n webcip uvicorn backend.app:app --port 8011
# open http://127.0.0.1:8011/  — backend serves the built app AND the API
```

## Run (as it runs in production: mounted at a subpath)

The build is mount-agnostic — `vite base: './'` plus `src/api/paths.ts`, which derives the API
root from the document URL. The same `dist/` serves from `/` and from `/webcip/`. To rehearse the
subpath locally, without Apache:

```
python deploy/subpath_test.py         # http://127.0.0.1:8012/webcip/
```

Deployment itself is `deploy/SERVER_SETUP.md` (once) then `deploy/deploy.sh` (every time).

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/load` `{path,name?}` | Decode a folder/file → cache + geometry JSON |
| GET | `/api/volume/{id}` | Raw pixel buffer (headers `X-Dtype`, `X-Dims`) |
| GET | `/api/header/{id}` | Tag/Keyword/Value header table |
| GET | `/api/images` | Loaded images |
| GET | `/api/browse?path=` | List a server directory |
| GET | `/api/config` | This server's data root + default load paths |
| GET | `/api/workflow` | Workflow state: banner, roles, per-step gating, who holds the workspace |
| POST | `/api/step/{key}` | Run one numbered step |
| POST | `/api/auto/start` | Run every step in sequence |
| GET | `/api/auto/{job}/events` | SSE progress |
| GET | `/api/health` | Liveness |

**One workspace, one worker.** The backend keeps the loaded images, the workflow session and the
job slot in module-level globals, so it must run as a single uvicorn worker and every browser
shares one workspace. A second browser is refused with 409 and shown an "in use" banner with a
Take over button (`backend/hold.py`).

## Tests

```
cd frontend && npm test          # core-math round-trip tests vs pv_core (vitest)
```
