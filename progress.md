# Result-Display App — Handoff (2D structure overlay RESOLVED)

## TL;DR
Building a **result-display workspace** for webcip: shows a cochlear-implant case's cropped CT
+ segmented structure/implant meshes + (later) electrode charts, in the **same vtk.js stack** as
the existing processing viewer, laid out like the old `musc-analytics/v2` display page (3D view
large/centered on top, three small MPR panes below, left sidebar).

**The 2D overlay now works** (filled, colored, smooth cross-sections on all three MPR panes) — each
mesh is cut by the slice plane (`vtkCutter`), the segments are chained into closed loops
(`frontend/src/render/structureCaps.ts::contourLoops`), and the loops are filled even-odd on the 2D
overlay canvas (`ReslicePane.drawStructureContours`). See "2D overlay — SOLUTION" below. Everything
else was already working.

---

## What works (do not touch)
- **Backend case loading**: `POST /api/case {folder}` → cropped CT (via pv_core/store) + parsed
  structure/implant meshes (streamed as binary), colors from `config/mesh/*.json`, curves.json.
- **3D view** (large, top): colored structure + implant mesh actors, v2 initial camera, zoom.
- **Implant rendering**:
  - 3D: colours come straight from config (`mesh_config/12.json` gray Carrier, `13.json` red
    Contacts — same as v2). Contacts are coincident with the Carrier surface, so `View3D` gives each
    actor a depth polygon offset by `render_order` (`setResolveCoincidentTopology` +
    `setRelativeCoincidentTopologyPolygonOffsetParameters`) so they draw as clean bands instead of
    z-fighting dashes — vtk's equivalent of v2's `renderOrder` + `depthFunc: LessEqual`.
  - **Contacts are OPEN patches** (welds to 308 verts with 308 boundary edges — un-closed caps, not
    closed beads), wound so their front faces point the wrong way. So: 3D renders the **opposite
    side** (`View3D` `setFrontfaceCulling(true)` for `s.typeId === 13`) so they show on the -x
    carrier surface; 2D **strokes** the cut segments as black marks (`STROKE_IN_2D` +
    `contourSegments`) because an open patch's cut is an open line, not a fillable loop. (The Carrier
    welds to a closed manifold, so it fills normally.)
  - 2D: `ReslicePane.OVERLAY_2D_COLOR` draws the Carrier RED and Contacts BLACK (both opaque) in the
    2D panes only; config/3D colours unchanged. This matches v2's real source — **not** `v2/js` or
    `3d_new/sceneSet.js` (which builds implants with `addClip=false`), but the parent app
    `app/view/component/postop/js/panelCtrl.js::showImplant`: `new Clip(carrier, plane, 'red')` /
    `new Clip(contacts, plane, 'black')` (no opacity arg → opaque). Structures still use their config
    colour at 0.5. (Gray Carrier / red Contacts would vanish over the gray CT, which is why 2D
    recolours them.)
- **Slice scroll step**: Display panes advance **1 image voxel** per wheel notch
  (`ReslicePane.sliceByVoxel`, set via `useScenePanes` opts; step = spacing along the view normal).
  Processing panes use `vs.sliceStep` (default now **2.0 mm**, `SLICE_STEPS` selector in `panels/Display.tsx`).
- **Layout + routing**: HashRouter, `/viewer` (Processing) and `/display` (Display) workspaces,
  shared `useScenePanes` hook, `attach/detach` lifecycle on the controller.
- **Coordinate correction**: the case NIfTIs encode L/R and A/P inverted (S/I correct). Fixed by a
  180°-about-S/I rotation `diag(-1,-1,1)` applied in the **backend** to BOTH the image direction
  cosines (`routes/case.py::_correct_lp_axes`) and the mesh verts (`mesh_io.build_group`). Verified.
- **Mesh cleanup**: Promontory ships 1,077,140 verts for 3,441 tris (~1M unreferenced). `mesh_io._compact`
  drops unreferenced verts → ~1,832. Needed for any per-slice CPU work to be viable.

## 2D contours: closed vs OPEN sections

**Openness is geometry, not a property of the structure.** A closed manifold (cochlea, ossicles)
cuts to closed loops; an open surface cuts to open ARCS — the External Auditory Canal is a tube
open at both ends, so its section is two curves that must not be joined up.

`structureCaps.contourLoops` therefore reports `closed` PER polyline, and only the contour/stroke
pass honours it (`contourOverlay`); a fill closes every chain, open ones included. That is exactly
what the desktop does: `reslice_view._cut_polylines` runs `vtkStripper` with
`JoinContiguousSegmentsOn`, which emits "one polyline per closed loop / open arc", `_set_polylines`
strokes them as they come, and only `_set_fill` appends the start point to close them.

Two traps, both regressions we shipped once:

- Deciding openness per STRUCTURE (the `STROKE_IN_2D` type-id list) is a v2-case rule for the
  implant contacts. Plan/cdb structures are `typeId: 0`, so they never matched and every section
  was closed — the EAC drew as a lens.
- The chain walk must start at an ENDPOINT (degree 1). From a middle vertex it walks to one end
  and stops, splitting a single arc into two polylines.

Covered by `src/render/__tests__/structureCaps.test.ts`.

## 2D overlay — SOLUTION (implemented)
**Exact cut + even-odd fill on the 2D canvas.** For each structure, per pane:
1. `vtkCutter` cuts the mesh by the slice plane → the exact intersection contour (a soup of 2-point
   line segments). Re-cut only when the slice moves (contours cached in world space); pan/zoom just
   re-project, so scrolling stays cheap.
2. `structureCaps.ts::contourLoops` chains the segments into closed loops (degree-2 manifold walk).
3. `ReslicePane.drawStructureContours` projects each loop to canvas px (`toCanvas`) and fills it on
   the 2D overlay canvas with `fill('evenodd')`, under the HUD. Like v2: the **Promontory and
   Round-window are excluded** from 2D (`HIDE_IN_2D`), fills use a fixed **0.5 opacity**, and
   structures use their config colour (implants use `OVERLAY_2D_COLOR`, see below).
This gives a **true planar cross-section**: filled, vector-smooth, handles concave outlines and
nested loops/holes (e.g. the cochlear spiral cut → a cluster of small filled turn cross-sections),
composited over the CT via canvas alpha, per-structure toggle. Verified via headless-Chrome
screenshots of `#/display` (default case): fills are confined to the true cut — no overflow — and
picking a point on the cochlea shows the correct multi-turn cross-section.

**Why NOT the v2 GPU `class Clip` port (a earlier dead end):** the v2 half-space-clip + invisible
depth-prime cap was reimplemented in raw WebGL2 (vtk.js can't express "opacity 0 + depthWrite" —
translucent geometry never writes depth, no colorMask). It renders, but for these **thin, non-convex
spiral shells** a single depth-prime can't cap the geometry: every combination of clip-half / face /
depth-func yields half-mesh silhouettes that spill past the true cross-section, not the planar cut.
The v2 trick only holds for blobby convex-ish solids. If you revisit it, that's the wall you'll hit.

## The 2D overlay problem (historical — how we got here)
Goal: on each small MPR pane, draw each structure/implant mesh as a **filled, colored cross-section
mask** that (a) lies **flat on the slice plane**, (b) is **smooth** (vector, not voxel-blocky),
(c) is **fast** (no lag when scrolling slices), (d) toggles per structure (visibility/opacity/color),
and composites over the opaque CT slice. This mirrors the v2 display's 2D overlay.

Key constraint discovered: **the meshes are hollow SURFACE shells (not solids).** So any thin-slab
clip yields a hollow band/ring, and a true *filled* interior requires generating a **cap polygon**
at the cut.

### Attempts (all in `frontend/src/render/ReslicePane.ts`, reverted between tries)
| # | Approach | Result |
|---|----------|--------|
| 1 | GPU mapper clip, thin slab (2 planes) | shell band; never sighted |
| 2 | `vtkClipClosedSurface`, single plane (half-space) | shows whole half-solid; laggy (pre-compaction) |
| 3 | `vtkClipClosedSurface`, slab + mesh compaction | still laggy (CPU, 11 meshes × 3 panes/slice) + not showing |
| 4 | Backend voxelize → uint8 label volume → GPU categorical-LUT overlay layer | **fragmented** (1 mm voxels look blocky) |
| 5 | GPU clip keep camera-side half + back-face-only (v2 "cap via back-faces") | smooth, fast, but **floats above the plane** (near half bulges toward camera) |
| 6 | GPU clip thin slab, both faces | flat + smooth + fast, but **hollow middle** (shell band) |
| 7 | `vtkCutter` (contour) + `vtkContourTriangulator` (fill) caps, re-cut on slice-change only + AABB cull | **CURRENT — "not working"** (needs diagnosis: caps not appearing? triangulation failing? depth/compositing?) |

### Trade-off matrix (the crux)
- **Filled + flat** ⟹ needs a real **cap polygon** (CPU: ClipClosedSurface = laggy; Cutter+Triangulator = lighter, current attempt).
- **GPU-only (fast)** ⟹ either **hollow** (slab band, #6) or **floats** (near-half back-face fill, #5).
- **Voxel mask (GPU, fast, filled)** ⟹ **fragmented** at 1 mm (#4). Also one-label-per-voxel loses
  nested structures unless stamped largest-first (that part was solved).

### Likely next directions to try
1. **Debug attempt #7**: verify cutter output has lines and triangulator produces polys for a known
   slice; check the cap isn't being culled by the camera clipping range or hidden behind the CT
   (nudge/`CAP_NUDGE`), check ContourTriangulator "output might have holes" warnings. It may be
   close — could be a compositing/visibility bug, not a conceptual one.
2. **Voxel mask at higher res** (#4 but 0.25–0.5 mm, or smooth the LUT) — kills fragmentation, stays
   GPU-fast, filled. Cost: bigger volume; per-structure masks if nested-toggle matters.
3. **Cutter contour outline only** (no fill) — smooth, flat, cheap, but not "filled" (user has
   leaned toward filled).
4. Reconsider whether the user actually needs *filled* vs a clean smooth *contour* — confirm.

---

## Layout shell (`layout/AppShell.tsx`) — implemented

Both workspaces are hosted in one shell with four regions — **left / centre / right / bottom** —
mirroring the desktop's dock arrangement (`desktop/main.py`: a left "Workflow" dock, a right
"Controls" dock, a closable bottom data dock). The bottom region spans only the **centre** column,
between the side columns, which is the same choice the desktop makes explicitly with
`setCorner(BottomLeft/BottomRight, Left/RightDockWidgetArea)`.

- Regions are optional; drag the 5 px handles to resize, double-click one (or use the header
  chevron) to collapse, and sizes persist to `localStorage` per workspace key. Collapse state is
  deliberately NOT persisted — a reload that came back with no panels reads as a broken app.
- `/viewer` = Workflow (module chips + Structures) · centre · Controls · Insertion plan.
  `/display` = its sidebar as `left` · 3D + MPR as the centre.
- **Right column is 300 px, not the desktop's 204.** `resizeDocks` is a *floor* in Qt — the dock
  then grows to its widgets' `sizeHint` — whereas a CSS width is final; at 204 the Display selects
  and Information values clip.

Three traps, all hit and fixed — worth knowing before touching this:

1. **Never read `e.currentTarget` from an async pointer handler.** React clears it, so the
   `pointerup` cleanup threw and left `pointermove` bound: dragging the *bottom* handle afterwards
   also resized the *left* column (to the drag's x), and sizes never persisted. Capture the element
   in a local at `pointerdown`.
2. **Percentage heights need a definite parent height, which a flex chain does not give.**
   `/display`'s `height: 70% / 30%` silently fell back to content size and the vtk host inflated to
   a 1200 px square, adding a page scrollbar. They are `flex: '7 1 0'` / `'3 1 0'` now. Every level
   of the shell also sets `minHeight/minWidth: 0` (a flex item defaults to `min-*: auto`, which lets
   content push past the container) and the centre column sets `overflow: hidden`.
3. **`ReslicePane.update` / `View3D.update` used to bail before `grw.resize()` when no image was
   loaded**, so an empty pane kept whatever size it guessed before layout settled. Both now resize
   the canvas first and only then skip the drawing.

Region content is resized, never re-parented — moving a `<canvas>` in the DOM loses its WebGL
context, so a collapsed region hides with `display: none` and keeps its nodes in place. Resizes
reach the renderers through the `ResizeObserver` `useScenePanes` already installs per host.

**Window-resize model** (deliberately dumb, so it settles in one step):

- Region sizes are PIXELS and do not scale with the window — the **centre absorbs** the change,
  which is how the desktop's docks behave.
- The only automatic size change is a **shrink** when a region no longer fits: the clamp is
  `box − MIN_CENTER_*`, the same ceiling a drag uses, so the two can't drift. It is shrink-only and
  returns the identical state object when nothing changed, so it cannot feed back into the pane
  ResizeObservers and oscillate. It does not grow a region back when the window grows again — the
  clamped size is now simply the current size.
- `RegionSpec.size` is an OPENING size, applied when the value **changes**, and the user's drag
  wins in between.

The trap: a workspace must not compute `size` inline from `window.innerHeight` on every render.
The pane ResizeObserver calls `controller.refresh()` on any layout change → the workspace
re-renders → a fresh `size` → the region resizes → the panes resize → … A window resize then
visibly *stepped* toward its resting size. `ProcessingApp` computes the electrode dock's opening
height in a `useMemo` keyed on the dock opening, matching the desktop's "apply the height when the
dock is next shown".

---

## Auto process — implemented (preop-only route)

**Load a CT with role Preop, then "Auto process …"** in `/viewer`. Runs the whole CIP pipeline
server-side across four Docker tools, ~3.5 min on the reference case:

| step | tool | image | time |
|---|---|---|---|
| Register preop to atlas | `dq.landmark_matrix` | `cip/dq:headlocnet` | ~35 s |
| Erase implant | `jn.create_synthetic` | `cip/jn:pix2pix` | ~13 s |
| Segment structures | `pcisp.segment` | `cip/pcisp:1.0` | ~64 s |
| Search for electrodes | `pcisp.segment_electrodes` | `cip/pcisp:1.0` | ~96 s |

**`projects/cip/auto_process.py` is NOT reusable** — unlike `workspace.load_workspace` and
`cdb_scene.assemble` it imports PySide6 and drives `ctx` (AppContext → MainWindow → Qt dialogs).
`backend/autoprocess.py` re-implements only the ORCHESTRATION; everything beneath it is reused
unchanged and is Qt-free: the tools, `reg_debug.jn_transform / pcisp_transform`, and
`segmentation.load_structures / load_postop`. `desktop/main.py`'s `run_synthetic_preop` /
`run_pcisp` / `run_pcisp_electrodes` show the exact call for each — ~5 lines of tool call inside a
Qt popup; port the call, drop the popup.

- **`backend/jobs.py` + `routes/auto.py`** — a run is minutes long, so `POST /auto/start` only
  starts it and the browser follows `GET /auto/{id}/events` (SSE). `GET /auto/{id}` lets a
  reloaded page rejoin. Each tool's `log=` callback becomes the event's `line`; the payload
  mirrors what `desktop/busy.py`'s `progress_sink` feeds the dialog's rows.
- **Results appear step by step, not only at the end.** The desktop's runners push straight into
  the live scene as each finishes (`ctx.add_created_image` + `_use_synthetic_preop` after Erase,
  `ctx.set_structures` after Segment, `apply_electrode_result` after Search), so the viewer fills
  in as the run proceeds. The browser can't be pushed to, so `Job.revision` bumps on every
  completed step, rides the SSE snapshot, and the dialog re-fetches `/result` (which is valid
  after ANY step, not just completion) and re-displays. `ProcessingApp` caches decoded voxels by
  image id — without that the ~200-350 MB synthetic would be refetched on every revision.
- **The result reuses the .cdb display path entirely.** A finished run is served in `POST /cdb`'s
  shape AND registered in the cdb route's registry under its job id, so `/cdb/{id}/mesh`,
  `/graph` and `/mip` serve it unchanged — no second display path, no duplicated endpoints.
  `ProcessingApp.displayCdb` is shared by "Load CDB" and a finished run.

Traps:

- **SSE vs `GZipMiddleware`.** Starlette wraps a streaming response and events then arrive in
  batches — fatal for a progress feed. It skips a response that already declares an encoding, so
  the stream sets `Content-Encoding: identity`.
- **Don't read `window.innerHeight`-style live values into a `size` prop** — see the layout
  section; the same class of feedback loop applies to any prop recomputed every render.
- The tool output does not echo the electrode model back (`lead_type` comes out 0), so the
  requested id is stamped onto the lead after parsing, exactly as the desktop's `_load` does.
- **Partial results must be renderable.** Fetching the result after every step means the
  electrode dock now sees a payload with NO LEAD (before 'Search for electrodes'). `_electrodes`
  omitted `series` in that case, so the chart adapter threw, React unmounted, and the page went
  BLANK mid-run. The no-lead branch now returns the full shape with empty arrays, the adapter
  tolerates a missing series, and the dock only opens once there are rows. `layout/ErrorBoundary`
  now wraps the routes so a render throw shows the error instead of a blank page.
- **`bake()` must not mutate what it is handed.** `Session.to_dict()` copies `extra` only
  SHALLOWLY, so `extra['ab']` / `extra['cip']` are the live objects' own dicts. Transforming them
  in place corrupted the source, and re-baking the same objects (which the per-step result now
  does) would transform them again on every call. It copies before writing.

### Files: uploads and tool outputs

- **Uploads** go to `<repo>/uploads/up_<random>/<filename>` (`routes/load.py::UPLOAD_DIR`,
  override with `WEBCIP_UPLOAD_DIR`) — NOT `/tmp`: they are hundreds of MB, must stay readable
  for as long as the image is loaded (pv_core reads lazily), and a `/tmp` sweeper removing one
  mid-session is not a failure mode worth having. **Nothing deletes them yet.**
- **Tool outputs** go to `pv_core.tools.jobs`' folder, `<pypv>/jobs/cip/<timestamp>/`, at
  **~2.6-3 GB per run** (the raw CT is written twice, plus four ~220 MB tool blobs). Three open
  problems: nothing calls `jobs.prune()`, so it grows without bound; the folder is per PROCESS
  not per run, so a second run OVERWRITES the first's outputs while `state['cip']['preseg_out']`
  still points at that path (a correctness bug — the fix is a per-job `work_dir`, which every
  tool function accepts); and the container writes as root through the bind mount, so a
  `shutil.rmtree(ignore_errors=True)` prune would silently fail to remove them.

**Not implemented**: the preop+postop route (`_run_postop_reg`: DQ global + AMIR local on the
modiolus) — `plan_steps` already branches for it; the synthetic-rerun `_prepare` path; and the
validation panel the desktop opens on completion.

---

## Postop CDB load + electrode analysis — implemented

**Load CDB in `/viewer`**: paste a `.cdb` path, press **Load CDB**. Verified against
`temp/0000000102_POSTOP_RIGHT_v0.cdb` — 2 images, 16 structures, 22 electrodes, read-only.

The parsing is the desktop's, unchanged: `projects.cip.cdb_scene.assemble` is the exact analogue
of `workspace.load_workspace`, so `backend/routes/cdb.py` is the cdb twin of `routes/plan.py` and
shares the world-baking (extracted to `backend/bake.py`). The electrode series come straight from
`projects.cip.electrode` (`table_rows` / `figure_series` / `graph_series`) and the projection from
`projects.cip.projection.render_for_lead`.

- **The lead's `extra['cie']` is never sent inline** — `dist_values` alone is n×300 floats. The
  load response is 26 KB; `/graph?setting=i` serves the curves (94 KB) per activation setting.
  NaN is **not** valid JSON, so `_clean` maps non-finite floats to `null` (Python's `json` emits
  bare `NaN`, which `JSON.parse` rejects — one missing distance would fail the whole response).
- **Curves tab** = `charts/CurvesGraph.tsx`, a canvas port of `electrode_panel._GraphCanvas`
  (x = distance-sample index cropped to the used range, frequency ticks on top and angle ticks
  below, the scala-coloured array strip with slanted connectors, the bid I-beam, the red scrub
  cursor with its ∠/f/d/z readout). The three simpler tabs reuse the existing recharts components
  through `core/electrodeData.ts`'s adapter; the MIP tab is `charts/MipView.tsx` (a port of
  `_ZoomView`: wheel zoom, drag pan, double-click fit, click-to-select).
- **Read-only**: `assemble` sets `session.state.cip.read_only`, so on/off toggling, the scala/angle
  context menu, Reset and Re-segment are all disabled — matching `electrode_panel._edits_locked`.

### Three geometry bugs this surfaced (all latent before, all in shared code)

A `.cdb` is the first data we render that is **cropped** and **not placed at identity** — its
preop/postop pair is re-framed onto the atlas (`reorient.reframe_scene_to_atlas`). Each of these
was invisible for every plain file and unregistered plan:

1. **`crop_origin` was never sent.** A cdb image's array is the CROP while `center_index` describes
   the FULL grid, so `buildVolume` placed the texture off by the crop offset (here 117,239,91
   voxels). It now places at `(cropOrigin − centre)`; pv_core does the same through
   `Image.vox_matrix`.
2. **`world_matrix` was never sent.** The frontend `Image` assumed identity, so the CT drew offset
   from the structures (which are baked to global world server-side). `store.geometry_dict` now
   emits it and `Image` seeds `baseWorldMatrix` from it.
3. **The slice plane was set in the wrong frame.** vtk.js's `ImageResliceMapper` interprets
   `SlicePlane` in the **image's own** coordinates — it cuts `image.getBounds()` with it
   (`updateResliceGeometry`) and only then applies the actor's user matrix. We set it in world.
   Identical while `worldMatrix` is identity; with the cdb's placement the panes showed a sliver
   of volume or none. `applySlot` now maps origin/normal through `worldMatrix` first.

Also added: **2D orientation "Primary"** (`scene.ts::primaryOrientation` + `ViewState.orientation`,
threaded through `viewAxes`). The desktop's postop view slices along the primary image's own grid
planes, not the world axes; without it the atlas-framed cdb renders obliquely. It is the inverse of
the image's placement rotation, so it is identity — and changes nothing — for every other case.

**Not ported**: "Center line view" (needs the oblique C-view frame — the same gap that defers
Orientation → AC/PC and Trajectory), and the electrode PDF export.

### UI notes

- The **load controls live in the left column** (Workflow), as the desktop's step "1. Load file",
  not in a strip over the viewer — `WorkflowColumn` takes them as a `loader` prop.
- **2D mesh overlay**: the Display group's "2D meshes" selector (none / contour / transparent /
  solid, the desktop's `set_contour_mode`) is the viewer's equivalent of the Display workspace's
  Mask/Contour toggle. It used to LIE on a cdb: the controller starts at `overlayMethod: 'mask'`
  (the Display workspace's default) while `meshMode2d` starts at `'contour'`, and only
  `applyPlanUi` ever pushed the mode — so a cdb showed filled masks under a control reading
  "Contour". `loadCdb` now pushes it.
- The three analysis charts take `dark` and `selectedLabel`. They were ported from v3, which puts
  them on a white panel; the viewer's dock is dark, where the v3 ink is unreadable. `selectedLabel`
  rings that electrode in EVERY series — the desktop's cross-chart highlight
  (`_FigureTab._mark_selected`) — driven by the same selection the Curves graph, the electrode
  table and the MIP share.

---

## Preop plan load (`.pws` / `.pwi`) — implemented

**Load → Plan in `/viewer`**: paste a workspace path next to the image path, press **Load plan**.
Verified end-to-end against `/data/mipwork/webcip/temp/webcip_plan_packed_DJ.pwi`.

**The parser is pv_core's, unchanged.** `POST /api/plan` (`backend/routes/plan.py`) calls
`pv_core.workspace.load_workspace` and only re-packages the result. Do not reimplement it.

- **Frames.** A plan object is stored in its source image's frame (`coord_space:"image_world"`).
  The desktop's 3D pane lives in the top image's PHYSICAL frame and maps everything through
  `four_up_viewer.world_to_scene`; the **web renders global world directly**. So the backend
  bakes `inv(source.world_matrix)` into every mesh and point (trajectory entry/target, the 10
  CIP guidance points, `t2w`, the scala A/B measures) — and maps the saved 3D camera the *other*
  way, `inv(world_matrix) @ translation(-center_phys)` (`_bake_camera`). **That camera shift is
  the one that bites**: without it the restored camera sits ~450 mm from the anatomy and the 3D
  pane looks empty.
- **Meshes never travel as JSON.** `backend/plan_mesh.py` welds (`vtkCleanPolyData` — CIP's IDL
  meshes are exploded), triangulates and computes normals, then emits the *existing* blob layout
  (`points f32 | normals f32 | tris u32`) that `api/client.ts::parseMeshBlob` already reads.
  Keys: `struct:<id>`, `carrier:<trajId>`, `track:<trajId>` (the track tube is built server-side
  with `vtkTubeFilter` along the 30 mm display line). `vtkTubeFilter` emits **strips**, so
  `blob()` must triangulate — guarding on `GetNumberOfPolys()` silently drops every tube.
- **Everything mesh-shaped reuses one path.** Plan structures, the carrier coil and the track
  cylinder all become `core/structure.ts::Structure`, so `View3D.setStructures` and the 2D
  `render/overlay/*` cut+fill work unchanged. They carry `origin` so panels can tell them apart;
  `typeId: 0` keeps the v2-display rules (`HIDE_IN_2D`, `OVERLAY_2D_COLOR`) out of the way.
- **Text and clock dials in vtk.js.** There is no `vtkVectorText` and no billboard text actor.
  Labels come back from `render/trajectory3d.ts` as world anchors and `View3D.drawLabels` projects
  them onto a 2D canvas over the pane (`renderer.worldToNormalizedDisplay`). The clock dial (ring
  + ticks + hour numbers) is one canvas texture on a `vtkPlaneSource` quad in the dial plane —
  vtk.js uploads canvases with `UNPACK_FLIP_Y_WEBGL`, so the canvas's top row lands at `v=1`, i.e.
  toward `+ŷ` = 12 o'clock. Being real in-plane geometry it still mirrors when viewed from behind,
  which is the desktop's deliberate "wrong side of the clock" cue.
- **Parity details worth keeping.** A/B measures are **3D only** (the desktop never draws them on
  the slices). A plan structure's 2D cross-section follows its 3D checkbox. The 2D trajectory line
  is gated by *Point projection*; the carrier coil appears only with *Insertion panel* on.
  `GZipMiddleware` halves the 115 MB volume response to ~67 MB.
- **Not ported** (needs new reslice machinery — `ViewState` has no orientation matrix):
  Orientation → *Insertion* (oblique reslice along `t2w`) and the Coordinates *TRAJ* frame, which
  this plan's `ui.coordinates` asks for. Also unrestored: pane maximize, click magnifier.

Files: `backend/routes/plan.py`, `backend/plan_mesh.py`, `core/planObjects.ts` (+ its tests),
`render/trajectory3d.ts`, `panels/Structures.tsx`, `panels/Insertions.tsx`.

---

## Reference code

### The old v2 site (what we're replicating — display page only)
- Entry: `/var/www/html/musc-analytics/v2/js/postop-main.js`, `preop-main.js`
- Charts: `/var/www/html/musc-analytics/v2/js/echarts-webtool.js` (for later phases D5/D6)
- 3D/scene modules (three.js): `/var/www/html/musc-analytics/app/view/component/postop/js/3d_new/`
  - `sceneSet.js` — `set3DCamera()` (norm/up per side), `set2DCamera()`
  - `scene.js` — `setCamera(position, lookAt, up)`
  - **`obj.js` — `class Clip` (~line 401): the "clever but strange" 2D cap = TWO meshes**
    (a back-face material colored + opacity to fill the cut, + an invisible front-face material
    with `depthWrite` to prime depth). This is the v2 2D overlay technique the user referenced.
- Sample case data: `/var/www/html/musc-analytics/postop_data/MUSC 1183_POSTOP_RIGHT_v0`
  (meta.json, stats.json, curves.json, image_crop.nii, structures.pkl, implants.pkl — .pkl are RAW
  binary, NOT pickle; per mesh `[V×3 f32 verts][F×3 idx]`, idx uint16 if V≤60000 else int32)
- Mesh colors config (copied into backend): `/var/www/html/musc-analytics/config/mesh/*.json`

### The desktop app (CIP viewer — the stack we match; NO 2D contour logic here)
- Source root: `/data/mipwork/webcip/` (pv_core at `/data/mipwork/webcip/pv_core`)
- `desktop/four_up_viewer.py` — `_structure_actor` (3D mesh rendering: vtkPolyData +
  vtkPolyDataNormals + colored actor)
- `desktop/reslice_view.py` — 2D pane (image masks only: fg red mask, coverage mask, crop VOI)
- `desktop/display_panel.py:88` — **"Contours" checkbox is GREYED OUT ("features not built yet")**,
  i.e. the desktop has NO 2D mesh-contour overlay to copy. This is greenfield; only v2 has it.

### Our webcip app
- Root: `/var/www/html/webcip`  ·  Notes: `PORTING_NOTES.md`, plan in
  `/home/sud/.claude/plans/i-have-a-big-glittery-wren.md`
- **Backend** (FastAPI over pv_core; conda env `webcip`):
  - `backend/routes/case.py` — case endpoints + `_correct_lp_axes` (L/R,A/P flip)
  - `backend/mesh_io.py` — `parse_structures/parse_implants`, `_compact`, `mesh_blob`, `build_group`
  - `backend/mesh_config.py` + `backend/mesh_config/*.json` — type_id → {name,color,opacity,render_order}
  - `backend/store.py` — `geometry_dict`, `raw_bytes` (reference; unchanged)
  - `backend/app.py` — includes case router
- **Frontend** (React 19 + Vite + TS + vtk.js):
  - `frontend/src/render/ReslicePane.ts` — the 2D pane; `setStructures` builds per-mesh cutters,
    `drawStructureContours` cuts + fills the cross-sections on the overlay canvas
  - `frontend/src/render/structureCaps.ts` — `contourLoops` (chains cutter segments into fill loops)
  - `frontend/src/render/View3D.ts` — 3D view (`setStructures`, `displayView`/`DISPLAY_ZOOM`)
  - `frontend/src/render/viewerController.ts` — `attach/detach`, `setStructures`, `updateStructure`
  - `frontend/src/render/useScenePanes.ts` — shared scene-setup hook
  - `frontend/src/render/meshPoly.ts` — `meshToPolyData` (SurfaceMesh → vtkPolyData)
  - `frontend/src/core/structure.ts` — `Structure` model, `makeStructure`
  - `frontend/src/api/client.ts` — `loadCase`, `fetchMeshManifest`, `fetchMesh`, `fetchCurves`, `parseMeshBlob`
  - `frontend/src/workspaces/DisplayApp.tsx` — Display workspace (3D large + 3 small panes + sidebar)
  - `frontend/src/workspaces/ProcessingApp.tsx` — extracted original viewer
  - `frontend/src/App.tsx` — HashRouter (Viewer/Display tabs)
  - `frontend/src/vtk-shims.d.ts` — `declare module` for `@kitware/vtk.js/Filters/Core/Cutter`

## Source tree: pypv

`backend/pvcore_path.py` defaults `WEBCIP_SRC` to **`/data/mipwork/pypv`** — the current desktop
tree. The older `/data/mipwork/webcip` checkout has diverged and has no auto-process tooling this
backend can drive; the two must never be mixed in one process, since both provide the same
`pv_core` / `projects` package names.

The switch cost two fixes, both from pv_core renames — worth checking first whenever the desktop
tree moves:

- `Image.name` → **`Image.display_name`**, and the constructor takes `display_name=`.
- (earlier) the per-field patient attributes became one **`Image.patient`** dict.

Known cosmetic gap: a `.pwi` written before the rename stores `name`, and pypv's
`workspace.apply_record` reads `display_name` — so an old plan's images show as "image". The
desktop shows the same; it is a file-format migration, not a web bug.

## How to run
- Backend: `conda run -n webcip uvicorn backend.app:app --port 8011` (from `/var/www/html/webcip`).
  It also serves the built frontend `dist/` at `:8011`.
- Frontend build: `cd frontend && npx tsc -b && npx vite build` (inotify limit blocks `vite dev`;
  use build + backend static serve). Then open `http://127.0.0.1:8011/#/display`.
- Typecheck/tests: `npx tsc -b`, `npx vitest run`.
- Env quirk: `pkill`/backgrounded uvicorn returns spurious exit 144 — ignore; verify with a curl to
  `:8011`.

## Remaining phases (after 2D overlay is fixed)
- **D4 — DONE** (matches v2 `panelCtrl.js::initCtrl`): DisplayApp sidebar has per-pane **slice-index
  sliders** (`SliceSliders` → `controller.setSliceIndex`/`sliceInfo`, moves the crosshair along the
  view normal), **CT window** Level/Window + Auto (`CtControls` → `setContrast`), and a structure
  list with per-structure **3D-show** (`Structure.visible`, v2 meshDisplay) + **2D-overlay-show**
  (`Structure.visible2d`, v2 "label" toggle — NOT a 3D name) + opacity. `ReslicePane` gates the 2D
  fill on `visible2d`; `View3D` actor visibility on `visible`.
- **D5 — IN PROGRESS** (charts via **Recharts**, not echarts — user's choice; one chart at a time):
  - Done: `fetchCurves` typed as `ElectrodeData` (client.ts). **Tabs live in the LEFT panel**
    (Display / Curves / Electrode Data) and switch only the left content — the 3D + MPR view on the
    RIGHT stays mounted+visible on every tab (matches v2 webtool.php `.main` tabs + `#container3d`).
    Left content is dark on Display, white on chart tabs. Per v2 `resizeScene()`, the left panel is
    380px on Display but **~45% on chart tabs** (3D/MPR narrow to fit); a `requestAnimationFrame`
    refresh after a tab change re-renders the vtk views at the new width. **Electrode table + mean distance**
    (`charts/ElectrodePanel.tsx`, ports v2 renderTable + renderMeanDist), colored scala badges via
    `charts/electrodeShared.ts`.
  - Done: **Electrode Data charts** (`charts/ElectrodeCharts.tsx`, Recharts) — matched to **v3**
    (`v3/js/echarts-webtool.js`, Chart.js), order: Frequency-Place Mismatch, Angle-by-Frequency,
    then Distance/Angle LAST. Angle-by-Frequency is a **connected line** (points sorted by freq), not
    bare dots. Freq axis uses v3's fixed `FREQ_TICKS` [500..20000] on a log [500,20000] domain with
    thousands-separator labels; electrode-# axis is linear at stepSize 4 (`elecTicks`), reversed for
    ≥22 electrodes; dist/angle dual-Y = dist[0,2] ticks[0,.5,1,1.5,2] + angle 5-tick. Shared consts
    (`FREQ_TICKS`, `elecTicks`, `ELECTRODE_PALETTE`) in `charts/electrodeShared.ts`. (recharts needs
    `react-is` — installed.) NOTE: use **v3** (not v2) as the chart reference going forward.
  - Done: **Curves** tab (`charts/CurvesPanel.tsx`, v3 renderCurves) — one distance-vs-log-freq line
    per electrode from `raw[i]`/`curvefreqs`, 22-colour `ELECTRODE_PALETTE`, X = log freq computed
    [xMin,xMax] with `FREQ_TICKS`, Y = Distance (mm) [0,4], clickable legend to show/hide electrodes.
  - Done: **ARO** block plot (`charts/AroPanel.tsx`, v3 renderARO/computeBlock) — v3 layout: left
    **"CHECK TO DEACTIVATE"** checklist (checked = deactivated) + **THRESHOLD** slider (0.1–1, step
    0.01) beside a dark log-X SVG block chart (odd-electrode y-ticks, sparse x-labels, black centre
    tick), with the **colour legend** below (Activated/Interacting/Deactivated/Can-be-activated).
    Height = `CHART_H - 100` so it fits beside the curves. Curves + ARO share one `active` set via
    `charts/CurvesTab.tsx` (curves legend ↔ ARO block colour ↔ checklist in sync).
  - Curves hover = **single nearest point** (custom `onMouseMove` + `ReferenceDot`, `activeDot=false`)
    not the whole x-slice; all chart tooltips are `.1f`. Curves + ARO share the height `CHART_H`. ARO
    "CHECK TO DEACTIVATE" list caps at 15 items then scrolls.
- **D6 — DONE**: **PDF** tab (`charts/PdfPanel.tsx`) — **v3 landscape layout**: header (title +
  Plan ID / Side) · **electrode table (left) + four 3D screenshots (right, 2×2)** · **three charts in
  a row** (Distance/Angle, Freq-Place Mismatch, Angle-by-Freq) · **electrode curves full width** ·
  medical disclaimer. Captured with **html2canvas** → single **landscape A4** via **jsPDF**. The 3D
  shots are v3's `_create3DScreenshots`: **modiolus (+scala) + implant from top/bottom** via
  `View3D.capturePdf3D()` (toggles structure visibility, frames along ±Y, `captureNextImage`,
  restores) → `controller.capturePdf3D()` — NOT the MPR CT slices. Charts are individually exported
  from `ElectrodeCharts.tsx` (with a `height` prop) and the table from `ElectrodePanel.tsx`
  (`ElectrodeTable`, `compact`). Deps: `jspdf`, `html2canvas`.
  - NOTE: ARO "CHECK TO DEACTIVATE" = `checked={!active.has(num)}` (active shows UNCHECKED, matching
    v3 where a checked box = deactivated/gray). If it ever looks inverted, suspect a stale bundle.
  - TODO: v3's **draggable point editing** on the ed_charts/curves (charts are static); then **D6**.
- **D6**: PDF export (jsPDF + html2canvas + chart PNGs + 3D screenshots).
