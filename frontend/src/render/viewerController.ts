// Shared glue between the imperative ReslicePanes/View3D and the React control panels.
// Panels call these methods and subscribe() for live read-outs.

import type { Image } from '../core/image';
import { Scene, primaryOrientation, viewAxes } from '../core/scene';
import type { ViewName } from '../core/scene';
import { identity, type Vec3 } from '../core/mat4';
import type { Marker, PlanSegment, ReslicePane, Tool2D } from './ReslicePane';
import type { Mode3D, View3D } from './View3D';
import type { Structure } from '../core/structure';
import type { OverlayMethodId } from './overlay';
import type { PlanData, PlanUi, PlanView } from '../api/client';
import {
  ALL_TRAJECTORIES,
  isReadOnly,
  planLead,
  planStructures,
  planTrajectories,
  trajCenter,
  trajDisplayLine,
  type PlanContact,
  type PlanSession,
  type PlanTrajectory,
} from '../core/planObjects';
import type { CdbData } from '../api/client';

/** How the plan's structure meshes appear on the 2D slices (desktop Display panel's
 *  "2D meshes", four_up_viewer.set_contour_mode). */
export type MeshMode2D = 'none' | 'contour' | 'transparent' | 'solid';

const CONTOUR_FILL_ALPHA = 0.35; // desktop reslice_view._CONTOUR_FILL_ALPHA ("transparent")

export class ViewerController {
  scene = new Scene();
  panes: ReslicePane[] = [];
  view3d: View3D | null = null;
  tool: Tool2D = 'position';
  structures: Structure[] = [];
  overlayMethod: OverlayMethodId = 'mask'; // 2D structure-overlay technique (all panes)
  private listeners = new Set<() => void>();

  // --- loaded preop plan (desktop main.py session + the Planning-group toggles) ----------
  plan: PlanSession | null = null;
  planName = '';
  activeTrajId: string | null = null; // a trajectory id, or ALL_TRAJECTORIES
  trajectoriesVisible = true; // Planning: Trajectories
  guidanceOn = false; // Planning: Insertion panel drives the clock dials / coil
  abVisible = true; // Planning: AB measure
  annotationOn = true; // Display: Annotation (object name labels)
  pointProjection = true; // Display: Point projection (gates the 2D trajectory line)
  meshMode2d: MeshMode2D = 'contour'; // Display: 2D meshes
  // Display-panel state a plan restores (workspace ui.display), held here so the panel is a
  // pure view of it and a load can drive it.
  referenceLine = false;
  projection3d: 'parallel' | 'perspective' = 'perspective';
  mode3d: Mode3D = 'surface';

  // --- loaded postop .cdb ---------------------------------------------------------------
  cdbId: string | null = null;
  electrodes: CdbData['electrodes'] | null = null;
  leadsVisible = true; // Planning: Electrodes
  electrodePanelOn = false; // Planning: Electrode panel (the bottom dock)
  /** The electrode NUMBER selected across the table, the Curves graph and the MIP — the desktop's
   *  electrode-selection bus (appcontext.select_electrode / on_electrode_selected). */
  selectedElectrode: number | null = null;

  get image(): Image | null {
    return this.scene.top; // panels read the top slot
  }

  /** Register a freshly-created set of panes + 3D view (a workspace mount). Both are set
   *  before syncing, so syncSlots always drives a live 3D view. */
  attach(panes: ReslicePane[], view3d: View3D): void {
    this.panes = panes;
    this.view3d = view3d;
    panes.forEach((p) => {
      p.tool = this.tool;
      p.setOverlayMethod(this.overlayMethod);
      p.onRegChange = () => this.emit();
      p.onFgPreview = (on: boolean) => this.setFgPreview(on);
    });
    this.syncSlots();
    if (this.structures.length) {
      view3d.setStructures(this.structures);
      this.pushStructuresTo2d();
    }
    if (this.plan) this.syncPlan();
  }

  /** Deregister the current panes + 3D view (a workspace unmount). Clears references BEFORE
   *  the caller deletes the objects, so no later callback (refresh/resize) can touch a dead
   *  render window — no per-object teardown flags needed. */
  detach(): void {
    this.panes = [];
    this.view3d = null;
  }

  /** Crop-tool fg drag: show/clear the red in-range preview on every pane (desktop on_fg_change). */
  setFgPreview(on: boolean): void {
    this.panes.forEach((p) => (p.fgPreview = on));
    this.refresh();
  }

  setTool(tool: Tool2D): void {
    this.tool = tool;
    this.panes.forEach((p) => p.setTool(tool));
    this.emit();
  }

  // Registration acts once on the moving (bottom) image, then re-renders every pane + 3D.
  regUndo(): void {
    this.scene.bottom?.regUndo();
    this.refresh();
  }

  regRedo(): void {
    this.scene.bottom?.regRedo();
    this.refresh();
  }

  regClear(): void {
    this.scene.bottom?.regClear();
    this.refresh();
  }

  setRegScaling(on: boolean): void {
    this.panes.forEach((p) => (p.regScaling = on));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  /** Push the current top/bottom slot images to every pane + the 3D view. */
  syncSlots(): void {
    this.applyOrientationMode();
    this.panes.forEach((p) => p.setSlots(this.scene.top, this.scene.bottom));
    if (this.scene.top) this.view3d?.setImage(this.scene.top);
  }

  /** The desktop's "2D orientation": slice along the world axes ("Original") or the primary
   *  image's own grid planes ("Primary" — the desktop's postop default). They are the same
   *  whenever the primary image sits at identity, which is every case except a loaded .cdb. */
  orientationMode: 'original' | 'primary' = 'primary';

  setOrientationMode(mode: 'original' | 'primary'): void {
    this.orientationMode = mode;
    this.applyOrientationMode();
    this.refresh();
  }

  private applyOrientationMode(): void {
    this.scene.view.orientation =
      this.orientationMode === 'primary' ? primaryOrientation(this.scene.top) : identity();
  }

  /** Re-render every pane and notify panels to re-read state. */
  refresh(): void {
    this.panes.forEach((p) => p.update());
    this.view3d?.update();
    this.emit();
  }

  addImage(image: Image): void {
    const first = this.scene.images.length === 0;
    this.scene.addImage(image);
    if (first) {
      this.scene.setCrosshair(
        image.pixelToWorld([
          (image.size[0] - 1) / 2,
          (image.size[1] - 1) / 2,
          (image.size[2] - 1) / 2,
        ]),
      );
    }
    this.syncSlots();
    this.emit();
  }

  selectTop(image: Image): void {
    this.scene.selectTop(image);
    this.syncSlots();
    this.refresh();
  }

  selectBottom(image: Image | null): void {
    if (image === null) this.scene.bottom = null;
    else this.scene.selectBottom(image);
    this.syncSlots();
    this.refresh();
  }

  // --- panel actions ---------------------------------------------------------
  moveCrosshair(world: Vec3): void {
    this.scene.setCrosshair(world);
    this.refresh();
  }

  recenterAll(): void {
    this.panes.forEach((p) => (p.center = [...(this.scene.view.crosshair as Vec3)]));
    this.refresh();
  }

  setSliceStep(mm: number): void {
    this.scene.view.sliceStep = mm;
    this.emit();
  }

  setRadiological(on: boolean): void {
    this.scene.view.radiological = on;
    this.refresh();
  }

  // Per-image settings target a specific image (default: the top slot).
  setInterpolation(mode: 'linear' | 'nearest', img: Image | null = this.image): void {
    if (img) img.interp = mode;
    this.refresh();
  }

  setColormap(rgb: number[][] | null, index = 0, img: Image | null = this.image): void {
    if (img) {
      img.colormap = rgb;
      img.colormapIndex = index;
    }
    this.refresh();
  }

  setContrast(level: number, window: number, img: Image | null = this.image): void {
    if (img) {
      img.level = level;
      img.window = window;
    }
    this.refresh();
  }

  setReferenceLine(on: boolean): void {
    this.referenceLine = on;
    this.panes.forEach((p) => (p.crosshairStyle = on ? 'dashed' : 'cross'));
    this.refresh();
  }

  setNavigationControl(on: boolean): void {
    this.panes.forEach((p) => (p.overlaysVisible = on));
    this.refresh();
  }

  set3dMode(mode: Mode3D): void {
    this.mode3d = mode;
    this.view3d?.setMode(mode);
    this.emit();
  }

  // --- result-display structures --------------------------------------------
  setStructures(structures: Structure[]): void {
    this.structures = structures;
    this.view3d?.setStructures(structures);
    this.pushStructuresTo2d();
    this.emit();
  }

  /** Hand the panes the meshes the 2D overlay should cut. The desktop's "2D meshes: none"
   *  drops them entirely (four_up_viewer._refresh_2d passes an empty contour list). */
  private pushStructuresTo2d(): void {
    const list = this.meshMode2d === 'none' ? [] : this.structures;
    this.panes.forEach((p) => p.setStructures(list));
  }

  /** Switch the 2D structure-overlay technique on every pane (mesh-projection / contour / mask). */
  setOverlayMethod(id: OverlayMethodId): void {
    this.overlayMethod = id;
    this.panes.forEach((p) => p.setOverlayMethod(id));
    this.emit();
  }

  /** Toggle/adjust a structure (3D vis, 2D-overlay vis, opacity) and re-render. */
  updateStructure(id: string, patch: Partial<Pick<Structure, 'visible' | 'visible2d' | 'opacity'>>): void {
    const s = this.structures.find((x) => x.id === id);
    if (!s) return;
    // A plan structure's 2D cross-section follows its 3D checkbox (four_up_viewer._refresh_2d
    // filters the contour list by `visible`); case meshes keep their independent 2D toggle.
    if (s.origin === 'plan-structure' && patch.visible !== undefined && patch.visible2d === undefined) {
      patch = { ...patch, visible2d: patch.visible };
    }
    Object.assign(s, patch);
    this.view3d?.syncStructureProps();
    this.panes.forEach((p) => p.update());
    this.emit();
  }

  // --- preop plan ------------------------------------------------------------
  /** Replace the whole scene with a loaded plan: the restored images + slots + view state
   *  (four_up_viewer.restore_workspace) and the plan's structures/trajectories
   *  (main.py::open_workspace). Trajectory meshes ride the structure list; their visibility
   *  is driven by the active trajectory and the Planning toggles (syncPlan). */
  loadPlan(data: PlanData, images: Image[], structures: Structure[]): void {
    this.scene.images = images;
    this.scene.top = images.find((im) => im.id === data.top) ?? images[0] ?? null;
    const bottom = images.find((im) => im.id === data.bottom) ?? null;
    this.scene.bottom = bottom === this.scene.top ? null : bottom;
    this.applyPlanView(data.view);
    this.plan = data.session;
    this.planName = data.name;
    const trajs = planTrajectories(this.plan);
    this.activeTrajId = trajs.length ? trajs[0].id : null;
    this.syncSlots();
    this.structures = structures;
    this.view3d?.setStructures(structures);
    this.pushStructuresTo2d();
    this.recenterAll();
    this.syncPlan();
  }

  /** Restore the workspace's 'ui' block: the per-pane pans, the 3D camera and the panel
   *  selections (four_up_viewer.apply_ui_state + main.py::_apply_ui_state). Runs after
   *  loadPlan, whose setStructures/setImage would otherwise re-frame the camera.
   *  Not restored: the pane maximize state and the click magnifier (no web equivalent yet). */
  applyPlanUi(ui: PlanUi): void {
    const d = ui.display ?? {};
    if (d.reference_line !== undefined) this.setReferenceLine(d.reference_line);
    if (d.annotation !== undefined) this.annotationOn = d.annotation;
    if (d.point_projection !== undefined) this.pointProjection = d.point_projection;
    if (d.mesh_mode) this.setMeshMode2d(d.mesh_mode as MeshMode2D);
    if (d.projection3d) this.set3dProjection(d.projection3d);
    // The 3D image display follows the top image's own render3d_mode (a preop plan saves
    // "none": the 3D pane shows the plan's meshes, not the CT).
    this.set3dMode((this.scene.top?.render3dMode ?? 'surface') as Mode3D);

    for (const [name, c] of Object.entries(ui.pan2d ?? {})) {
      if (!c) continue;
      const view = name.toLowerCase() as ViewName;
      const pane = this.panes.find((p) => p.view === view);
      if (pane) pane.center = [c[0], c[1], c[2]];
    }
    if (ui.camera3d) this.view3d?.setCamera(ui.camera3d);
    this.syncPlan();
    this.refresh();
  }

  /** Replace the scene with a loaded .cdb (postop). Same shape as loadPlan — the backend's cdb
   *  route mirrors the plan route — plus the electrode payload and the read-only flag. */
  loadCdb(data: CdbData, images: Image[], structures: Structure[]): void {
    const { cdbId, electrodes } = data;
    this.scene.images = images;
    this.scene.top = images.find((im) => im.id === data.top) ?? images[0] ?? null;
    const bottom = images.find((im) => im.id === data.bottom) ?? null;
    this.scene.bottom = bottom === this.scene.top ? null : bottom;
    this.plan = data.session;
    this.planName = data.name;
    this.cdbId = cdbId;
    this.electrodes = electrodes;
    this.selectedElectrode = null;
    this.activeTrajId = null;
    // A cdb's crop is a few cm across; the 256 mm default FOV would show a speck.
    const top = this.scene.top;
    if (top) {
      this.scene.view.fovMm = Math.max(...top.size.map((s, i) => s * top.spacing[i])) * 1.15;
      // Centre of the CROP, expressed in FULL-grid indices — pixelToWorld works in the full frame
      // for a cropped image, so the crop's centre is cropOrigin + (size-1)/2, not (size-1)/2.
      this.scene.setCrosshair(
        top.pixelToWorld([
          top.cropOrigin[0] + (top.size[0] - 1) / 2,
          top.cropOrigin[1] + (top.size[1] - 1) / 2,
          top.cropOrigin[2] + (top.size[2] - 1) / 2,
        ]),
      );
    }
    this.syncSlots();
    this.structures = structures;
    this.view3d?.setStructures(structures);
    this.pushStructuresTo2d();
    // Push the current 2D-mesh mode to the panes. Without this the panes keep the controller's
    // initial overlay method ('mask', the Display workspace's default) while the Display panel's
    // "2D meshes" selector reads "Contour" — the control and the picture disagree. A plan gets the
    // same push from applyPlanUi's saved ui.display.mesh_mode.
    this.setMeshMode2d(this.meshMode2d);
    this.set3dMode('none'); // 3D shows the meshes + electrodes, not the CT
    this.recenterAll();
    this.syncPlan();
  }

  get readOnly(): boolean {
    return isReadOnly(this.plan);
  }

  /** The localized lead's REAL contacts (placeholders dropped), in contact order. */
  contacts(): PlanContact[] {
    return (planLead(this.plan)?.contacts ?? []).filter((c) => c.index >= 0 && c.position);
  }

  /** Select an electrode by NUMBER, from the table / Curves graph / MIP. A selection also centres
   *  the views on that contact, as the desktop's select_electrode does. */
  selectElectrode(label: number | null): void {
    this.selectedElectrode = label;
    const c = this.contacts().find((x) => Number(x.label) === label);
    if (c?.position) {
      this.scene.setCrosshair(c.position as Vec3);
      this.recenterAll();
    }
    this.syncPlan();
  }

  setLeadsVisible(on: boolean): void {
    this.leadsVisible = on;
    this.syncPlan();
  }

  setElectrodePanel(on: boolean): void {
    this.electrodePanelOn = on;
    this.emit();
  }

  /** The Load menu's "Clear workspace": the plan AND the images — back to an empty session.
   *  (`clearPlan` keeps the images, for the side-switch reset.) */
  clearWorkspace(): void {
    this.scene.images = [];
    this.scene.top = null;
    this.scene.bottom = null;
    this.clearPlan();
    this.syncSlots();
    this.refresh();
  }

  /** Drop the loaded plan (the desktop's Clear workspace). */
  clearPlan(): void {
    this.plan = null;
    this.planName = '';
    this.cdbId = null;
    this.electrodes = null;
    this.selectedElectrode = null;
    this.activeTrajId = null;
    this.setStructures([]);
    this.syncPlan();
  }

  /** TS twin of pv_core.workspace.apply_view. */
  private applyPlanView(v: PlanView): void {
    const vs = this.scene.view;
    vs.crosshair = [v.crosshair[0], v.crosshair[1], v.crosshair[2]];
    vs.sliceStep = v.slice_step;
    vs.zoom = v.zoom;
    vs.blendAlpha = v.blend_alpha;
    vs.fovMm = v.fov_mm;
    vs.radiological = v.radiological;
  }

  planStructures(): Structure[] {
    return this.structures.filter((s) => s.origin === 'plan-structure');
  }

  trajectories(): PlanTrajectory[] {
    return planTrajectories(this.plan);
  }

  activeTrajectory(): PlanTrajectory | null {
    return this.trajectories().find((t) => t.id === this.activeTrajId) ?? null;
  }

  /** The trajectories to render: none with the Trajectories toggle off, all of them in 'All'
   *  mode, else the single selected one (four_up_viewer._trajectories_to_draw). */
  trajectoriesToDraw(): PlanTrajectory[] {
    if (!this.trajectoriesVisible) return [];
    if (this.activeTrajId === ALL_TRAJECTORIES) return this.trajectories();
    const active = this.activeTrajectory();
    return active ? [active] : [];
  }

  /** Select which trajectory is shown; a single selection also centres the views on it
   *  (four_up_viewer.set_active_trajectory). */
  setActiveTrajectory(id: string | null): void {
    this.activeTrajId = id;
    const active = this.activeTrajectory();
    if (active) {
      const c = trajCenter(active);
      if (c) {
        this.scene.setCrosshair(c);
        this.recenterAll();
      }
    }
    this.syncPlan();
  }

  setTrajectoriesVisible(on: boolean): void {
    this.trajectoriesVisible = on;
    this.syncPlan();
  }

  setGuidanceVisible(on: boolean): void {
    this.guidanceOn = on;
    this.syncPlan();
  }

  setAbVisible(on: boolean): void {
    this.abVisible = on;
    this.syncPlan();
  }

  setAnnotation(on: boolean): void {
    this.annotationOn = on;
    this.syncPlan();
  }

  setPointProjection(on: boolean): void {
    this.pointProjection = on;
    this.syncPlan();
  }

  /** The desktop's "2D meshes" mode: which overlay method the panes use and at what opacity. */
  setMeshMode2d(mode: MeshMode2D): void {
    this.meshMode2d = mode;
    this.overlayMethod = mode === 'contour' ? 'contour' : 'mask';
    const alpha = mode === 'solid' ? 1.0 : mode === 'transparent' ? CONTOUR_FILL_ALPHA : null;
    this.panes.forEach((p) => {
      p.setOverlayMethod(this.overlayMethod);
      p.setOverlayFillAlpha(alpha);
    });
    this.pushStructuresTo2d();
    this.refresh();
  }

  /** Crosshair to a structure's mesh centroid, everything re-centred on it
   *  (four_up_viewer.focus_structure — the checklist's click-to-focus). */
  focusStructure(id: string): void {
    const s = this.structures.find((x) => x.id === id);
    const pts = s?.mesh.points;
    if (!pts || !pts.length) return;
    let x = 0;
    let y = 0;
    let z = 0;
    const n = pts.length / 3;
    for (let i = 0; i < pts.length; i += 3) {
      x += pts[i];
      y += pts[i + 1];
      z += pts[i + 2];
    }
    this.scene.setCrosshair([x / n, y / n, z / n]);
    this.recenterAll();
  }

  /** The scala-tympani A/B width segments, in world (structure extra.ab pa/pb). */
  private abSegments(): [Vec3, Vec3][] {
    if (!this.abVisible) return [];
    const segs: [Vec3, Vec3][] = [];
    for (const s of planStructures(this.plan)) {
      const ab = s.extra?.ab;
      if (!ab) continue;
      for (const key of ['pa', 'pb'] as const) {
        const seg = ab[key];
        if (seg && seg.length >= 2) segs.push([seg[0] as Vec3, seg[1] as Vec3]);
      }
    }
    return segs;
  }

  /** The world-space lines the 2D panes draw: each shown trajectory's display line, gated by
   *  Point projection as in the desktop (four_up_viewer._refresh_2d). The A/B measures are 3D
   *  only there, so they are not included. */
  private planSegments(): PlanSegment[] {
    if (!this.pointProjection) return [];
    const segs: PlanSegment[] = [];
    for (const t of this.trajectoriesToDraw()) {
      const line = trajDisplayLine(t);
      if (line) segs.push({ p0: line[0], p1: line[1], color: t.color, width: 2 });
    }
    return segs;
  }

  /** Push the whole plan display state to the renderers: which trajectory meshes are on, the
   *  3D guidance geometry, and the 2D line overlays. */
  syncPlan(): void {
    const drawn = this.trajectoriesToDraw();
    const shown = new Set(drawn.map((t) => t.id));
    for (const s of this.structures) {
      if (s.origin === 'plan-track') {
        // the yellow track cylinder rides with the trajectory itself
        s.visible = shown.has(s.id.slice('track:'.length));
      } else if (s.origin === 'plan-carrier') {
        // the orange carrier coil only with the insertion guide on
        s.visible = this.guidanceOn && shown.has(s.id.slice('carrier:'.length));
      } else {
        continue;
      }
      s.visible2d = s.visible;
    }
    this.view3d?.syncStructureProps();
    this.view3d?.setTrajectories(drawn, this.abSegments(), {
      guidance: this.guidanceOn && this.trajectoriesVisible,
      annotation: this.annotationOn,
    });
    const segs = this.planSegments();
    const markers = this.contactMarkers();
    this.panes.forEach((p) => {
      p.setPlanSegments(segs);
      p.setMarkers(markers, this.pointProjection);
    });
    this.view3d?.setMarkers(markers);
    this.emit();
  }

  /** The lead's contacts as labelled world points, in contact order — the desktop draws these
   *  through its marker layer (four_up_viewer.set_leads: yellow, connected, radius 0.15), gated by
   *  the Planning 'Electrodes' toggle. Point projection then decides, per 2D pane, which of them
   *  that slice shows and whether they are joined; the 3D spheres ignore it. */
  private contactMarkers(): Marker[] {
    if (!this.leadsVisible) return [];
    return this.contacts().map((c) => ({
      position: c.position as Vec3,
      label: this.annotationOn ? String(c.label) : '',
      selected: Number(c.label) === this.selectedElectrode,
    }));
  }

  /** Current slice index + max for a pane (voxel index along the view normal). */
  sliceInfo(view: ViewName): { index: number; max: number } | null {
    const img = this.image;
    if (!img) return null;
    const ax = this.axisAlignedWith(view, img);
    const ijk = img.worldToPixel(this.scene.view.crosshair as Vec3);
    return { index: Math.round(ijk[ax]), max: img.size[ax] - 1 };
  }

  /** Move the crosshair so this pane shows slice `index` (v2 ChangeSlice per orientation). */
  setSliceIndex(view: ViewName, index: number): void {
    const img = this.image;
    if (!img) return;
    const ax = this.axisAlignedWith(view, img);
    const ijk = img.worldToPixel(this.scene.view.crosshair as Vec3);
    ijk[ax] = Math.max(0, Math.min(img.size[ax] - 1, Math.round(index)));
    this.scene.setCrosshair(img.pixelToWorld(ijk));
    this.refresh();
  }

  /** Image axis index most aligned with a view's slice normal. */
  private axisAlignedWith(view: ViewName, img: Image): number {
    const [, , n] = viewAxes(view, this.scene.view.radiological, this.scene.view.orientation);
    const d = img.direction; // row-major 3x3; column k = image axis k in world
    let best = 0;
    let bestDot = -1;
    for (let k = 0; k < 3; k++) {
      const dot = Math.abs(d[k] * n[0] + d[3 + k] * n[1] + d[6 + k] * n[2]);
      if (dot > bestDot) {
        bestDot = dot;
        best = k;
      }
    }
    return best;
  }

  set3dProjection(kind: 'parallel' | 'perspective'): void {
    this.projection3d = kind;
    this.view3d?.setProjection(kind);
    this.emit();
  }

  /** Four 3D report screenshots (modiolus/scala + implant from top/bottom) for the PDF. */
  async capturePdf3D(): Promise<string[]> {
    return (await this.view3d?.capturePdf3D()) ?? ['', '', '', ''];
  }
}
