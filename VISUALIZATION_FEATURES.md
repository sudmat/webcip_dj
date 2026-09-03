# WebCIP — Visualization Functionality Inventory

Complete feature list of the CIP desktop viewer (`/data/mipwork/webcip`,
`python -m desktop.main`) to replicate on the web. Derived from a full read of
`desktop/reslice_view.py`, `four_up_viewer.py`, the panels, and `pv_core/`.

**Legend:** **[P1]** build now (visualization + Load File) · **[SUB]** display
substrate for the later step 2–5 workflows (build the rendering, not the workflow) ·
**[OUT]** out of scope this phase.

**Port status:** ✅ done · 🔨 in progress · ⬜ not started.

---

## A. File loading (workflow step 1)
- **[P1]** ✅ Load NIfTI (.nii/.nii.gz), NRRD, MetaImage (.mha/.mhd) via SimpleITK (backend).
- **[P1]** ⬜ Load DICOM series from folder — Patient/Study/Series/Image tree, pick largest
  series, gap-fill missing slices + gantry-tilt de-shear (`pv_core/dicom_scan.py`,
  `image_readers._build_volume`).
- **[P1]** ⬜ Load raw headerless volume + PAR/REC — editable dims/spacing/orientation/dtype/
  byteorder/header-size/rescale (`image_readers.RawProps`).
- **[P1]** ⬜ Image Browser dialog: source selector (DICOMs / Others / Database), per-series
  preview (single-slice slider + all-slice grid), header tab.
- **[P1]** 🔨 Header viewer: Tag/Keyword/Value table, filter, export txt/csv (backend
  `/header/{id}` ✅; UI ⬜).
- **[P1]** ⬜ Multiple images per scene; unique auto-naming; rename / remove / clear / export NIfTI.
- **[OUT]** Oracle DB image source (`oracle_db.py`) — gate behind `project.uses_database`.
- **[SUB]** Workspace **load** (`.pws` / `.pwi` zip) ✅ — `POST /api/plan` reuses
  `pv_core.workspace.load_workspace`; the images, structure meshes, CIP trajectories + guidance
  and the saved view/camera/panel state come back in `/viewer`. Workspace **save** and legacy
  IDL `.pws` import ⬜.

## B. 2D Multi-Planar Reconstruction (the core)
- **[P1]** ⬜ Three linked ortho panes — Coronal (TL), Sagittal (TR), Axial (BL); world-space
  reslice through a shared crosshair (`vtkImageReslice`, axes = `mat_world_to_pixel() @ [u v n o]`).
- **[P1]** ✅ View-axis definitions (`view_axes`, radiological/anatomical `_ORIN` table) — TS port.
- **[P1]** ⬜ Native-resolution reslice: output raster sized to pane pixels; 1:1 under a parallel
  camera; re-resliced on zoom/resize.
- **[P1]** ⬜ Interpolation per image: linear / nearest.
- **[P1]** ⬜ Sub-voxel slice stepping along the plane normal; slice step 0.1/0.2/0.5/1.0 mm.
- **[P1]** ✅ Direction-cosine handling + nearest-axis snapping (`geometry.nearest_axis_aligned`).
- **[P1]** ⬜ Radiological ↔ anatomical convention toggle.

## C. Compositing / overlay pipeline
- **[P1]** ⬜ Foreground-window alpha (voxels outside `fg_window` → transparent) + coverage mask.
- **[SUB]** ⬜ Two-image top/bottom blend (`vtkImageBlend` compound; union-coverage alpha).
- **[SUB]** ⬜ Overlay tool: checkerboard quadrants / patch window.
- **[SUB]** ⬜ Crop-dim (per-pixel-alpha black outside the crop box).
- **[SUB]** ⬜ Surface-threshold red mask feedback in 2D.
- **[P1]** ⬜ Colormaps/LUTs: 256-entry IDL `colors1.tbl` palettes; gray-ramp default.
- **[SUB]** ⬜ Label-map LUT overlay (`Image.label_lut`) — model exists; 2D overlay not wired in desktop.

## D. Window/level & contrast
- **[P1]** ✅ Per-image W/L (model + default 1–99 percentile from backend).
- **[P1]** ⬜ Interactive right-drag W/L; double-click reset; live readout overlay.
- **[P1]** ⬜ Contrast presets (Bone/Soft-tissue/Lung/Brain), auto-contrast, header-contrast.

## E. 2D interaction tools (toolbar)
- **[P1]** ⬜ Position: crosshair set/drag, click-magnifier, recenter-all, pan, W/L, wheel-slice;
  edge hot zones (zoom/slice/blend); corner +/− buttons; maximize pane.
- **[P1]** ⬜ Measurement: distance (2 clicks), angle (3 clicks), ortho distance; world-space; mm/deg.
- **[SUB]** ⬜ Crop tool (box handles, fg-bound drags, untilted reslice).
- **[SUB]** ⬜ Overlay tool; Manual-registration tool (translate/rotate/scale, undo/redo reg-chain).

## F. Overlays / annotations (per pane)
- **[P1]** ⬜ Crosshair / reference lines (short-cross or dashed; toggle).
- **[P1]** ✅ Orientation letters R/L/A/P/S/I logic (`geometry.axis_letter`) — TS port; ⬜ rendering.
- **[P1]** ⬜ Orientation head-icon (STL, top-left, re-aimed).
- **[P1]** ⬜ Scale bar, color bar (split in blend), pane-name label, hot-zone dividers,
  intensity-at-crosshair readout.
- **[SUB]** ⬜ Registration fiducial markers (source/target + labels; point-projection).

## G. Coordinate systems (Coordinates panel)
- **[P1]** ✅ All 17 systems + activation conditions + direction-flip axes + to/from-values
  (`coords.py`) — TS port, verified vs pv_core.
- **[P1]** ✅ CT Patient (RPI, default), Scan1 Patient/MM/Pixels/World/RAS/Table, World (LPS) —
  transforms verified.
- **[P1]** ⬜ Panel UI: frame dropdown, 3 axis rows (label/flip combo + value box), Update-coords
  live toggle, Go button.
- **[OUT]** Atlas/Frame/MC/AC/PC/Trajectory/US systems (gated on DBS/FUS/atlas steps).

## H. 3D view (bottom-right pane)
- **[P1]** ⬜ Render modes: Volume (transfer functions), Surface (isosurface, solid/transparent),
  MIP, Slice (3 ortho planes), None.
- **[P1]** ⬜ Trackball camera; parallel ↔ perspective; zoom (wheel/edge/HUD); pan; orbit about
  pivot; 3D scale bar; orientation marker; maximize.
- **[P1]** ⬜ Surface pick (z-buffer → crosshair); 3D measure (surface distance); 3D reference crosshair.
- **[SUB]** ⬜ Surface-threshold drag; structure meshes; crop box; markers; pivot.

## I. Panels & display options (right dock)
- **[P1]** ⬜ Information panel: Image tab (name, dims, voxel size, orientation) + Patient tab
  (MRN, name, DOB, gender). (Data all present in backend meta.)
- **[P1]** ⬜ Display panel: slot selectors, interpolation, colormap, 3D mode + surface style +
  iso/cutoff, foreground window, projection, reference-line, point-projection, navigation-control,
  slice step, click magnifier.
- **[P1]** ⬜ Orientation panel: Original / AC-PC / Trajectory radios — Original only functional.
- **[SUB]** ⬜ Planning panel: Trajectories / Guidance / AB-measure toggles (not wired in desktop).

---

## Notes for the port
- The desktop has **no 2D label/segmentation overlay** — structures render only in the 3D pane
  as meshes; `Contours`/`Annotation` are stubbed (greyed).
- All coordinate/matrix math is isolated in pure-numpy `pv_core` (`geometry`, `image`, `scene`,
  `coords`) — ported to TS and verified (`frontend/src/core/`).
- Heavy image I/O (DICOM assembly, header parsing) stays in Python (`pv_core`), invoked once at
  load by the FastAPI backend.
- The runtime resampling engine is `vtkImageReslice`; the web port uses **VTK.js** (V1 risk spike:
  filter chain vs custom GLSL reslice/composite shader).
