# Handoff — deployment session, 2026-09-02

Where things stand after a session on **deploying WebCIP to AWS**, plus the loading/UX and
performance work that came out of it. Written for a fresh conversation.

The approved deployment plan is at `~/.claude/plans/this-repo-is-a-breezy-starfish.md`.
Operational detail lives in `deploy/SERVER_SETUP.md`; this file is the state and the open ends.

---

## Run it

```bash
export WEBCIP_DATA_ROOT=/var/www/html/musc-analytics/postop_data:/data/mipwork/webcip/temp:/var/www/html/webcip/uploads
conda run -n webcip uvicorn backend.app:app --port 8011      # serves the API AND the built SPA
# http://127.0.0.1:8011/
```

A server is running on **127.0.0.1:8011** right now. The frontend build is current
(`cd frontend && npm run build`). `python deploy/subpath_test.py` serves the same app at
`http://127.0.0.1:8012/webcip/` to rehearse the production mount without Apache.

**Interpreter:** `/data/anaconda3/envs/webcip/bin/python3` (3.10.20). The system `python3` is a
different env and does **not** have uvicorn/fastapi.

---

## 1. Deployment (the session's main task)

**Decisions taken with the user:** full pipeline on AWS · mounted at a subpath under the existing
PHP site's URL · `git pull` + restart script · no authentication in this plan (its own session) ·
de-identified test data only · an "in use" banner rather than silent clobbering.

**Topology.** Apache proxies the whole `/webcip/` subtree to uvicorn on 127.0.0.1:8011, which
serves both the API and the SPA — the same process that runs locally, so what is tested is what
ships.

**The build is mount-agnostic.** `vite.config.ts` has `base: './'`, and `frontend/src/api/paths.ts`
derives the API root from `document.baseURI` at runtime. One artifact works at `/` and at
`/webcip/`. Requires the Apache redirect `/webcip` → `/webcip/`: without the trailing slash the
mount reads as the parent directory (there is a unit test pinning this).

**`deploy/` holds everything:** `install.sh` (rewrites paths and installs the units),
`webcip.service`, `apache-webcip.conf`, `deploy.sh`, the prune/restart timers, `subpath_test.py`,
and `SERVER_SETUP.md`.

### The target box — measured, and it is too small

`34.198.28.2`, `ssh aws_public` works (Amazon Linux 2, ec2-user already in `docker` + `wheel`).
Apache 2.4.54 + php-fpm running, `proxy_module`/`proxy_http_module` already loaded, Drupal's
rewrites scoped to `/drupal` so `/webcip` is clear. Port 80 only, no TLS.

| | Box | Needed |
|---|---|---|
| RAM | **3.8 GB**, no swap | 8 GB floor |
| vCPU | 2 | 4 preferred |
| Free disk on `/` | **8.3 GB** of 50 GB | ~100 GB |
| Python | **3.9.12** | **3.10+** |
| Node | absent | needed for the build |

**RAM is the blocker.** Measured with `docker stats` through a real run on the dev box:

| | Peak RSS | CPU | Wall |
|---|---|---|---|
| backend idle | 0.48 GB | — | — |
| backend, preop + postop loaded | 1.15 GB | — | — |
| **`cip/dq`** (atlas) | **5.34 GB** | up to 1890% (~19 cores) | ~31 s |
| `cip/pcisp` (segment) | 1.22 GB | ~101% — single-threaded | 88 s |

`cip/dq` alone exceeds the box's total RAM. Cores matter less than expected: the *longer* step is
single-threaded, so 2 vCPU costs minutes, not feasibility. **The box needs resizing before the
pipeline can run there**; the viewer half would be fine today.

Python 3.9 is also fatal — the backend's Pydantic models use `str | None` (evaluated at import)
and `numpy 2.2` has no 3.9 wheels. AL2's extras stop at 3.8, so `SERVER_SETUP.md` §3 recommends
Miniconda for the interpreter only.

### Not yet done

- Nothing has been deployed. No GitHub repo, no deploy keys, no `install.sh` run.
- **`git init` is done, 139 files staged, ZERO commits.** Nothing over 1 MB, no scans
  (`uploads/`, `dist/`, `node_modules/` are gitignored). The user's standing rule is to commit
  only when asked.
- Unverified on the real box: whether the distro interpreter takes the `vtk 9.6.2` /
  `PySide6 6.11.1` pins, and the headless Qt/GL package set.

---

## 2. Performance — one big win, one half unmeasured

`GZipMiddleware` was compressing the large binary responses. Measured on a 400 MB CT:

| | Before | After |
|---|---|---|
| `GET /api/volume` | **14.17 s** | **0.66 s** |
| `GET /api/surface` (18.2M triangles, 451 MB) | **19.39 s** | **5.54 s** |

It spent 13.4 s to save 27% — CT voxels are noisy and barely deflate. (The comment in `app.py`
claiming they "deflate to roughly half" was wrong.) Fixed by setting `Content-Encoding: identity`
on `/volume` and `/surface`, which makes the middleware skip them; JSON is still compressed.

**Caveat for AWS:** break-even is roughly 35–70 Mbps. On loopback this is not close; on a slow
WAN link compressing would win. Re-measure on the real deployment.

Loading a 400 MB CT, server-side:

| route | total |
|---|---|
| upload (browser dialog) | **6.08 s** — 2.89 s transfer + disk write, 2.54 s decode, 0.65 s volume back |
| server path (explorer) | **3.20 s** — decode + volume |

### Open: the browser half

The user reports **12 s to see the image, +6 s for the mesh** on a 300 MB volume. About half is
server-side (above); the rest is browser-side and **has not been profiled**: reading the file to
POST it, allocating the TypedArray, and vtk.js uploading to the GPU. That is where the remaining
time is. Two candidate fixes, neither done:

1. **Skip the re-download.** After an upload the browser already holds the file bytes; for an
   uncompressed `.nii` the voxels are the file after a 352-byte header, so it could build the
   TypedArray locally instead of fetching `/api/volume`. Needs care with `scl_slope`/`scl_inter`,
   dtype, byte order, and `.nii.gz` (not sliceable) — a fast path with a fallback.
2. **Decimate the isosurface.** `/api/surface` ships the raw FlyingEdges output — 18.2M triangles
   / 451 MB at a low threshold (only 7,982 at the default). Of its 5.5 s, ~4.8 s is the same C++
   call the desktop makes and ~0.7 s is transfer; the browser then rebuilds it all. Decimation
   would cut transfer and GPU upload but changes fidelity vs the desktop — **ask before doing it**.

---

## 3. Loading UI — where it landed, and the live confusion

Step 1 is now:

```
Load preop CT …            browser file dialog → /api/upload
Load postop CT …           browser file dialog → /api/upload
Load CDB …                 browser file dialog → /api/upload-file → /api/cdb
Load run …                 explorer (folder)   → /api/job
─────────
From a file on the server ▸  Preop CT / Postop CT / CDB or plan   → /api/load, no upload
─────────
Clear workspace
```

**The user's last message was confusion about exactly this**: they clicked "Load preop CT …",
saw the browser dialog, and asked why it was not the server-side one. The two are separate
entries and only the submenu skips the upload. It may be worth making that distinction clearer in
the labels — e.g. "Load preop CT (upload) …" — or reconsidering the layout.

**Why an explorer exists at all.** Browsers refuse to expose a chosen file's path (`input.value`
returns `C:\fakepath\…` by spec), and even if they did it would be a path on the *client*. So
"select a file already on the server without uploading it" is impossible through the native
dialog. `FilePicker.tsx` browses the server via `/api/browse` and returns a path. It is
*required* for `Load run` (a run folder is ~3 GB and must stay server-side) and an optimisation
for the rest.

**Other pieces added this session:**

- `GET /api/config` — server-side defaults; no more paths baked into the bundle.
- `GET /api/openable` — discovers case folders, plans, `.cdb`s and past runs under
  `WEBCIP_DATA_ROOT` (`:`-separated, plus the tools' own jobs root). Drives the Display tab's
  case dropdown.
- `POST /api/job` + `backend/jobfolder.py` — **reopen a past pipeline run from its output
  folder**, no re-run. Rebuilds the images from the headerless `.im` raws plus the tool config.
  This is *faithful*, not approximate: `segmentation._voi_structures` maps meshes with
  `world_matrix @ inv(mat_world_to("patient"))`, in which the world matrix cancels, so only dims /
  spacing / orientation matter — all recorded. Only the absolute DICOM origin is lost. Handles
  both tool config dialects (`[Preop Dimensions]` vs `[Image Dimensions]` + `[Voxel Size]`).
- `backend/result.py::cdb_payload` — the one cdb-shaped payload builder, shared by live runs and
  reopened folders.
- `POST /api/upload-file` — stores a file and returns its server path, no decoding.

Runs currently reopenable: `20260902-142332-276936` (full: 13 structures + 22-contact lead),
`20260902-133603-872759` (segment only: 11 structures), `20260901-163053-940441`.

---

## 4. The shared-workspace hold

There is **one** `workflow.Session` for the whole server, so two browsers share one workspace.
The hold makes a collision visible rather than silent:

- The first mutating action claims it; others get **409** with the holder and can take over.
- It **never lapses while a step is running** (`jobs.current()`), and lapses after
  **`HOLD_IDLE_SECONDS = 3 min`** otherwise — it was 30 min, which made an idle server read as
  busy.
- The banner distinguishes "another session is running X" from "last used at HH:MM, nothing is
  running".
- `POST /api/workflow/release` hands it back. **Any script or API testing should call this**,
  otherwise the user's browser is locked out until the timer expires. This caused a real
  complaint this session.

Real per-session isolation is still the deferred fix (`_SESSIONS` keyed by the `webcip_sid`
cookie, plus `_STORE` ownership and LRU eviction).

---

## 5. Two mistakes made this session — read these

1. **I deleted the user's older job folders.** `pv_core.tools.jobs.prune()` is *count*-based
   (keeps 5) and I had called it at backend startup; a server restarts constantly, so eight
   Sep-1 folders lost their outputs — including `20260901-125644-853327`, a desktop run the user
   had referenced. The startup call is **removed**; reclamation is now only
   `deploy/webcip-prune.timer`, which is age-based (7 days). Do not reinstate a count-based prune
   on startup.
2. **I truncated `backend/jobs.py`.** Extracting `result()` with a slice to end-of-file deleted
   the module-level registry (`_JOBS`, `start()`, `get()`), so the pipeline was silently broken
   until caught. It is restored with an added `current()`. Lesson: after refactoring a module,
   exercise a code path that uses it — a step run, not just an import.

---

## 6. Deferred, in priority order

- **Security, as its own session** (the user's explicit call). No authentication;
  `allow_origins=["*"]`; `GET /api/browse` walks any readable directory and `/api/load|plan|cdb|
  case|job` accept any absolute path — on a box whose service account is in the `docker` group.
  `/api/browse` is now genuinely used by the picker, so it can no longer just be deleted; it
  wants confining to `WEBCIP_DATA_ROOT`. Put an Apache IP allowlist or basic auth in front until
  then.
- Profile the browser-side load (§2).
- **Step 7 / Save CDB** — still the proper way to persist a finished result; `/api/job` is the
  workaround.
- Manual workflow: the deferred interactive panels (Adjust segmentation, Pick up seeds,
  Erase-implant review, Validate plan).
- **Two-scan route step 6 fails**: `cip/pcisp` segfaults (exit 139) when the preop and postop are
  on different grids, because `run_electrode_search` hard-codes `preop_to_postop=None,
  atlas_to_postop=atlas_to_preop` ("assumes the preop/postop are aligned"). The header has the
  right fields and step 5 stores the matrices; the sign convention is undocumented and untested,
  so it needs verifying rather than guessing. Single-scan route works.
- `/tmp/webcip_up_*` strays; `_STORE` never evicts (mitigated only by the nightly restart timer).
