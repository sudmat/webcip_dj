# WebCIP — Porting Notes & Handoff

Status, architecture, design choices, trade-offs, bugs, and desktop differences for the
web port of the CIP desktop viewer. Pair this with `README.md` (how to run) and
`VISUALIZATION_FEATURES.md` (feature inventory). Desktop source: `/data/mipwork/webcip`.

---

## 1. Status — what's done

The **visualization layer + Load File (workflow step 1)** is fully ported and verified in
the browser. Everything the desktop's 2D/3D viewer and right control panels do is working.

| Phase | Scope | State |
|---|---|---|
| P0 | FastAPI backend over `pv_core` + Vite/React/TS/VTK.js scaffold | ✅ verified |
| P0.5 | TS port of `pv_core` geometry/image/scene/coords; 78 vitest tests vs Python | ✅ verified |
| V1–V3 | GPU MPR reslice, exact desktop mouse model, 2D overlay HUD | ✅ verified |
| V4 | Right panels: Coordinates (17 systems), Information, Orientation, Display, Planning + colormaps | ✅ verified |
| V5 | 3D view: Volume/Surface/MIP/None, server-side C++ isosurface, GPU pick, camera, reference crosshair | ✅ verified |
| V6 | All 2D tools: two-slot blend, manual registration, crop (+fg red preview + transparency), measure, overlay (checker/patch) | ✅ verified |

**Deferred / optional** (see §7): 3D surface-distance measure, DICOM *folder* upload,
workspace save/load, label/structure overlays, AC-PC/Trajectory orientation, DB source.
These are out of the visualization scope or explicitly deferred (steps 2–5 of the workflow
— registration/segmentation pipelines — were always out of scope).

---

## 2. Architecture

```
Browser  frontend/  (Vite + React + TS + VTK.js)          ← all rendering (GPU)
  src/core/     TS port of pv_core math (mat4, geometry, image, scene, coords)  ← per-frame, verified vs Python
  src/render/   ReslicePane (2D), View3D (3D), FourUp, viewerController, reslice, volumeData
  src/panels/   Toolbar, RightDock, Information, Coordinates, Display, Orientation, Planning, ui
  src/api/      client.ts (REST)
        │  REST
        ▼
Backend  backend/  (FastAPI)  — imports pv_core UNCHANGED via WEBCIP_SRC (default /data/mipwork/webcip)
  routes/load     POST /api/load {path} · POST /api/upload (file)  → decode + geometry JSON
  routes/volume   GET  /api/volume/{id}   → raw pixel buffer (X-Dtype, X-Dims headers)
  routes/surface  GET  /api/surface/{id}  → isosurface mesh (C++ vtkFlyingEdges3D), binary
  routes/header   GET  /api/header/{id}   → Tag/Keyword/Value rows
  routes/colormaps GET /api/colormaps, /api/colormap/{i}  → colors1.tbl palettes
  routes/browse   GET  /api/browse?path=  → server directory listing
```

**Split of responsibility** (the load-bearing decision): the backend is a **one-time
decoder** (heavy medical I/O needs SimpleITK/GDCM/pydicom) and a **surface generator**
(needs C++ FlyingEdges). It never renders or interpolates for display. The browser owns all
MPR/volume rendering + interaction. Only the small, pure coordinate math (~500 LOC) is
ported to TS; the big I/O (`dicom_scan`, `image_readers._build_volume` gap-fill/gantry-tilt,
`header`) stays in Python and is reused verbatim.

---

## 3. Key design choices & trade-offs

1. **GPU rendering (`vtkImageResliceMapper`), not CPU reslice.** The first spike used
   `vtkImageReslice` on the CPU (JS) and was laggy on crosshair/pan drag. Switching to the
   GPU reslice mapper (volume uploaded once as a 3D texture, only a world-space slice plane +
   camera move per frame) made interaction snappy. **Trade-off:** GPU actors can't be
   spatially masked or run arbitrary imaging filters, which forced workarounds for two
   features (overlay checker/patch, fg red preview) — see below.

2. **Thin Python backend reusing `pv_core`.** Avoids re-porting the intricate DICOM assembly
   (slice gap-fill + gantry-tilt de-shear), NIfTI/PAR-REC/raw decoders, and header parsing to
   JS. Only `geometry.py`/`image.py`/`scene.py`/`coords.py` (pure math) were ported to TS and
   verified against Python reference values (78 tests, all 11 coordinate spaces, real +
   synthetic oblique image).

3. **Server-side isosurface (C++ FlyingEdges), streamed as a binary mesh.** vtk.js only ships
   a slow pure-JS marching cubes (3–5 s on 211³, and coarse if downsampled). The backend runs
   the **same `vtkFlyingEdges3D`** the desktop uses (~0.23 s, full-res 302k pts) and streams
   points+normals+tris; the browser renders the mesh directly. Placed in the frontend's
   global-world frame so no client transform is needed. **Trade-off:** ~14 MB transfer per
   surface (fine on localhost; add gzip for remote).

4. **GPU depth pick (`vtkHardwareSelector`, `captureZValues`) for 3D**, not `vtkCellPicker`.
   Cell picking ray-casts every triangle (O(n), was 3–5 s per click); the hardware selector
   reads the z-buffer at one pixel → `worldPosition` (O(1), instant) — the same z-buffer
   technique the desktop uses.

5. **Manual registration via actor `userMatrix = inv(worldMatrix)`.** Editing the moving
   (bottom) image's registration chain updates its world matrix; the slice actor's user
   matrix moves the volume live over the blend. The chain math is unit-tested.

6. **Overlay tool = CPU stencil composite, scoped to the tool.** The checkerboard/patch needs
   per-pixel selection between two images, which the GPU two-slot blend can't do. This is the
   one place the desktop's CPU technique (`vtkImageReslice` → colormap → checker/patch mask)
   is replicated, and only while the overlay tool is actively dragging — everything else stays
   GPU. Seams are pixel-perfect (one raster). **Trade-off:** slightly laggy on drag +
   CSS-resolution softness (acceptable for a transient QA tool).

7. **fg red preview = red band in the colour transfer function (GPU).** First implemented as a
   CPU red mask (reslice all 3 panes per frame) — too laggy. Replaced with a per-frame CTF
   that maps the in-range `[flo,fhi]` band to red and the rest to grayscale — instant, and
   visually identical to the desktop's red mask.

---

## 4. Differences from the desktop (deliberate)

| Area | Desktop | Web | Why |
|---|---|---|---|
| Compositing | CPU (`vtkImageBlend`, C++) | GPU (slice actors) | interactivity |
| Isosurface | in-process FlyingEdges (~100–300 ms) | server FlyingEdges + stream (~1 s incl. transfer) | no fast JS MC |
| Crop box "show cropped" | hard voxel clip | **dim-outside overlay** (region indicator) | vtk.js reslice mapper ignores clipping planes |
| Overlay borders | none drawn | **yellow haloed divider lines** added | clarity when both images are gray |
| Overlay/crop base view | reverts to blend on release | reverts to **top-only** (non-blending) | requested |
| fg drag rate | `(value_max−value_min)*0.003` | `window*0.01` | this CT's `value_max`=28696 makes the full-range rate ineffective |
| Per-slot settings | gear menu per slot | **"Settings for: Top/Bottom"** selector | reads more clearly as a web panel |
| Tool icons | 20×20 dark PNGs | **same PNGs, recoloured white** | dark web toolbar |
| Coordinate systems | full set incl. DBS/FUS/atlas | 17 ported; atlas/frame/DBS/FUS **gated off** | out of scope (CIP visualization) |
| 2D label overlay | none (structures are 3D-only) | none | matches desktop |
| 3D pick | z-buffer (all modes) | hardware selector (**surface mode**; volume-mode z-pick not wired) | vtk.js exposes selector, not a raw depth read |

---

## 5. Bugs found & fixed (notable)

1. **V4 contrast blown out + W/L/contrast dead.** Switching color mapping to an
   `RGBTransferFunction` without `setUseLookupTableScalarRange(true)` left the default
   `colorWindow=255`, saturating everything outside [0,255] and ignoring W/L edits. vtk.js
   indexes the color texture by the CTF's range only when that flag is on. **Fixed.**
2. **Surface off-centre / mirrored.** `vtkImageMarchingCubes` computes points as
   `origin + index*spacing` and **ignores the direction matrix**. (Superseded by the
   server-side surface, which is direction-correct; the JS path was removed.)
3. **Surface too large / vanishes on wheel.** In Surface mode `resetCamera()` ran before the
   async mesh arrived, so the camera never framed it. **Fixed:** reset the camera when the
   mesh loads.
4. **Surface build + pick slow (3–5 s each).** JS marching cubes + CPU cell picker. **Fixed:**
   server C++ surface + GPU hardware selector.
5. **fg transparency "did nothing".** The drag rate was scaled to the full intensity range
   (`value_max`=28696), so a normal drag barely moved the bound. **Fixed:** window-based rate.
6. **Measure angle lines drawn black.** `halo()` (text) mutates the canvas `strokeStyle`; the
   green was set once before the loop. **Fixed:** set the colour per item.
7. **Overlay patch too large.** Used `0.18*min(w,h)`; desktop is `0.2*min/2 = 0.1`. **Fixed.**
8. **fg red preview laggy.** CPU reslice × 3 panes/frame. **Fixed:** GPU CTF red band.

**Environment gotchas (not code bugs):**
- `vite dev` hits `ENOSPC: file watchers` — the box's inotify limit is exhausted. Fix on the
  host: `sudo sysctl fs.inotify.max_user_watches=524288`. Otherwise use `npm run build` and let
  the backend serve `frontend/dist` at `http://127.0.0.1:8011/`.
- `npm install` needs `--legacy-peer-deps` (pinned in `.npmrc`) — vtk.js declares a `@babel`
  peer that conflicts with the Vite plugin.

---

## 6. Known limitations / caveats

- **Overlay tool:** CPU composite → mild lag on drag; CSS-resolution (a touch soft); pixels
  outside a volume use the background level rather than true transparency.
- **Crop box:** a *region indicator* (dims outside), not a hard voxel clip.
- **Registration:** relies on `vtkImageResliceMapper` honouring the actor `userMatrix` while
  slicing at a world plane (verified visually; the chain math is unit-tested).
- **3D pick:** works in Surface mode (pickable geometry); volume-mode z-pick isn't wired.
- **Surface transfer:** ~14 MB per surface — add gzip (`GZipMiddleware`) for non-local use.
- All rendering assumes the **unregistered** placement for the volume geometry; registration
  is applied via the actor matrix (2D) — the 3D view shows the **top** image only.

---

## 7. Not done / deferred

- **3D surface-distance measure** (2 surface picks → line + mm). Offered; not built. The 3D
  tools toolbar (Position/Measure) also isn't added — 3D defaults to the Position behaviour.
- **DICOM *folder* upload** from the browser (single-file upload works; server-path DICOM
  folders load via `/api/load` + `pv_core/dicom_scan`).
- **Image Browser dialog** (DICOM tree preview) — currently load by server path or single-file
  upload; the full browser UI isn't built.
- **Workspace save** (`.pws` / `.pwi` zip) and **legacy IDL `.pws` import**. Workspace *load*
  is done — see "Preop plan load" in `progress.md`.
- **Oracle DB image source** (gated behind `project.uses_database`).
- **AC-PC / Trajectory orientation** transforms (deferred in the desktop too — Original only).
- **Label-map 2D overlay, fiducial markers** — belong to the step 2–5 workflows. (Structure
  meshes and planning objects now arrive with a loaded plan.)
- **Head orientation icon** (small corner 3D head), **click magnifier**, **2D magnifier**,
  **point projection** — minor display niceties.

---

## 8. File map

**Backend** (`backend/`): `app.py`, `pvcore_path.py`, `store.py`,
`routes/{load,volume,surface,header,colormaps,browse}.py`.

**Frontend core** (`frontend/src/core/`): `mat4.ts` (row-major 4×4 to match numpy),
`geometry.ts`, `image.ts` (all coord spaces + registration chain), `scene.ts`, `coords.ts`,
`__tests__/core.test.ts` (+ `reference.json` generated from `pv_core`).

**Frontend render** (`frontend/src/render/`): `ReslicePane.ts` (the big one — 2D pane: GPU
reslice + blend + all tool interaction + HUD + CPU overlay + fg CTF), `View3D.ts`,
`FourUp.tsx`, `viewerController.ts` (glue to panels), `reslice.ts` (reslice params + CPU
reslice helper), `volumeData.ts` (build vtkImageData).

**Frontend panels** (`frontend/src/panels/`): `Toolbar.tsx` (icon tools), `RightDock.tsx`,
`Information/Coordinates/Display/Orientation/Planning.tsx`, `ui.tsx`.

**Reference generator** (regenerate the test fixture after touching the math):
`scratchpad/gen_reference.py` was used; it builds `frontend/src/core/__tests__/reference.json`
from `pv_core` + `backend.store`. Re-run in the `webcip` conda env if `pv_core` math changes.

---

## 9. Run & verify

```
# backend (serves /api and, if built, the SPA at /)
cd /var/www/html/webcip
conda run -n webcip uvicorn backend.app:app --port 8011          # + --reload for dev

# frontend
cd frontend
npm install                 # .npmrc pins legacy-peer-deps
npm run build               # → dist, served by the backend at http://127.0.0.1:8011/
#   or: npm run dev         # needs the inotify limit raised (see §5)
npx vitest run              # 78 core-math tests vs pv_core

# smoke test volume
curl -s -X POST localhost:8011/api/load -H 'Content-Type: application/json' \
  -d '{"path":"/data/mipwork/webcip/temp/VUMC.307.93791.nii"}'
```

Test data: `/data/mipwork/webcip/temp/VUMC.307.93791.nii` (the screenshot CT, 211×211×110).
Load it twice (or upload a second file) to exercise blend / registration / overlay.
