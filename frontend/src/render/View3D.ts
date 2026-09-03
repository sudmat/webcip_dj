// The 3D pane (bottom-right). Ports desktop four_up_viewer.py 3D: per-image render mode
// (volume / surface / MIP / none) with CT transfer functions, a world-axis reference
// crosshair, an orientation-marker widget, and the desktop 3D mouse model:
//   right-drag = rotate (orbit) · middle-drag = pan · wheel = zoom
//   left-click/drag = pick the surface point under the cursor and move the crosshair.

import '@kitware/vtk.js/Rendering/Profiles/Volume';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkAxesActor from '@kitware/vtk.js/Rendering/Core/AxesActor';
import vtkOpenGLHardwareSelector from '@kitware/vtk.js/Rendering/OpenGL/HardwareSelector';
import { FieldAssociations } from '@kitware/vtk.js/Common/DataModel/DataSet/Constants';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';

import type { Image } from '../core/image';
import type { ViewState } from '../core/scene';
import type { Vec3 } from '../core/mat4';
import type { Structure } from '../core/structure';
import { buildVolume } from './volumeData';
import { fetchSurface } from '../api/client';
import { meshToPolyData } from './meshPoly';
import type { PlanTrajectory } from '../core/planObjects';
import type { Marker } from './ReslicePane';
import {
  buildAbActors,
  buildMarkerActors,
  buildTrajectoryScene,
  type Label3D,
  type TrajectoryOpts,
} from './trajectory3d';

export type Mode3D = 'volume' | 'surface' | 'mip' | 'none';

// CT transfer functions (Hounsfield units) — desktop _CT_COLOR / _CT_OPACITY.
const CT_COLOR: [number, number, number, number][] = [
  [-1000, 0.0, 0.0, 0.0],
  [-400, 0.3, 0.2, 0.15],
  [200, 0.85, 0.75, 0.6],
  [1500, 1.0, 1.0, 0.95],
];
const CT_OPACITY: [number, number][] = [
  [-1000, 0.0],
  [120, 0.0],
  [300, 0.15],
  [1200, 0.7],
  [3000, 0.85],
];
const GRAY: [number, number, number] = [0.502, 0.502, 0.502];
const AXIS_COLORS: [number, number, number][] = [
  [1, 0.25, 0.25], // L/R
  [0.3, 1, 0.3], // A/P
  [0.4, 0.55, 1], // S/I
];
const ROT_RATE = 0.5; // deg per px
const DISPLAY_ZOOM = 1.8; // result-display: fill the large 3D view with the structures
const PDF_SHOT_ZOOM = 1.5; // report snapshots: zoom past resetCamera's loose fit

export class View3D {
  private grw: ReturnType<typeof vtkGenericRenderWindow.newInstance>;
  private renderer: ReturnType<
    ReturnType<typeof vtkGenericRenderWindow.newInstance>['getRenderer']
  >;
  private image: Image | null = null;
  private mode: Mode3D = 'surface'; // desktop default (pv_core/image.py render3d_mode)
  private container: HTMLElement;
  private vs: ViewState;

  private volume = vtkVolume.newInstance();
  private volumeMapper = vtkVolumeMapper.newInstance();
  private colorTf = vtkColorTransferFunction.newInstance();
  private opacityTf = vtkPiecewiseFunction.newInstance();

  private surfaceActor = vtkActor.newInstance();
  private surfaceMapper = vtkMapper.newInstance();
  private surfaceBuilt = false; // mesh fetched from the backend
  private surfaceLoading = false;

  private crossActors: vtkActor[] = [];
  private orientation: ReturnType<typeof vtkOrientationMarkerWidget.newInstance> | null = null;
  private structures: Structure[] = [];
  private structActors = new Map<string, { actor: vtkActor; mapper: ReturnType<typeof vtkMapper.newInstance> }>();
  displayView = false; // result-display: frame structures with the v2 initial camera
  /** Whether an image / structure / surface arriving may re-frame the camera.
   *
   *  Cleared while a takeover panel owns the view (render/viewScope.ts), because those
   *  re-frames are not one-time: setStructures runs on EVERY structure-list change, and a
   *  pipeline step's result lands as a fresh list, so a panel's framing would be undone by the
   *  next revision. It also protects a plan's restored ui.camera3d from the async surface load
   *  below, which lands after applyPlanUi has already set the camera. */
  autoFrame = true;
  private selector = vtkOpenGLHardwareSelector.newInstance({
    captureZValues: true,
    fieldAssociation: FieldAssociations.FIELD_ASSOCIATION_POINTS,
  });
  private picking = false;
  private drag: { button: number; x: number; y: number } | null = null;

  // Preop-plan trajectory geometry + the A/B measures (render/trajectory3d.ts). Their text
  // labels are drawn on the 2D canvas below, since vtk.js has no text actor.
  private trajActors: vtkActor[] = [];
  private trajLabels: Label3D[] = [];
  private markerActors: vtkActor[] = [];
  private markerLabels: Label3D[] = [];
  private labelCanvas: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;

  onPick: ((world: Vec3) => void) | null = null;

  constructor(container: HTMLElement, vs: ViewState) {
    this.container = container;
    this.vs = vs;
    this.grw = vtkGenericRenderWindow.newInstance({ background: GRAY });
    this.grw.setContainer(container as HTMLElement);
    this.renderer = this.grw.getRenderer();
    this.grw.getInteractor().setInteractorStyle(null as never); // custom mouse model below

    for (const [x, r, g, b] of CT_COLOR) this.colorTf.addRGBPoint(x, r, g, b);
    for (const [x, a] of CT_OPACITY) this.opacityTf.addPoint(x, a);
    const vp = this.volume.getProperty();
    vp.setRGBTransferFunction(0, this.colorTf);
    vp.setScalarOpacity(0, this.opacityTf);
    vp.setInterpolationTypeToLinear();
    vp.setShade(true);
    vp.setAmbient(0.3);
    vp.setDiffuse(0.7);
    this.volume.setMapper(this.volumeMapper);

    this.surfaceMapper.setScalarVisibility(false);
    this.surfaceActor.setMapper(this.surfaceMapper);
    this.surfaceActor.getProperty().setColor(0.9, 0.85, 0.78);

    this.crossActors = AXIS_COLORS.map((c) => {
      const a = vtkActor.newInstance();
      a.getProperty().setColor(c[0], c[1], c[2]);
      a.getProperty().setLineWidth(2);
      a.setMapper(vtkMapper.newInstance());
      a.setPickable(false);
      this.renderer.addActor(a);
      return a;
    });

    this.labelCanvas = document.createElement('canvas');
    Object.assign(this.labelCanvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    container.appendChild(this.labelCanvas);
    this.lctx = this.labelCanvas.getContext('2d')!;

    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    container.addEventListener('contextmenu', this.preventCtx);
  }

  setImage(image: Image): void {
    this.image = image;
    if (!image.pixels) return;
    this.volumeMapper.setInputData(buildVolume(image));
    this.surfaceBuilt = false; // mesh fetched lazily from the backend when Surface is shown

    this.applyMode();
    this.setupOrientationMarker();
    if (this.autoFrame) this.renderer.resetCamera();
    this.update();
  }

  /** Render the result-display structure/implant meshes (colored actors). */
  setStructures(structures: Structure[]): void {
    this.structures = structures;
    const ids = new Set(structures.map((s) => s.id));
    for (const [id, a] of this.structActors) {
      if (!ids.has(id)) {
        this.renderer.removeActor(a.actor);
        this.structActors.delete(id);
      }
    }
    for (const s of structures) {
      if (!this.structActors.has(s.id)) {
        const mapper = vtkMapper.newInstance();
        mapper.setInputData(meshToPolyData(s.mesh));
        mapper.setScalarVisibility(false);
        // v2 renderOrder via depth polygon offset: pull higher-order meshes toward the camera so
        // the electrode Contacts (order 2) render as clean bands on the coincident Carrier (order 1)
        // instead of z-fighting into dashes.
        if (s.renderOrder > 0) {
          mapper.setResolveCoincidentTopology(1); // Resolve.PolygonOffset
          mapper.setRelativeCoincidentTopologyPolygonOffsetParameters(-s.renderOrder, -s.renderOrder * 4);
        }
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        actor.getProperty().setSpecular(0.25);
        actor.getProperty().setSpecularPower(50);
        this.renderer.addActor(actor);
        this.structActors.set(s.id, { actor, mapper });
      }
    }
    this.syncStructureProps();
    if (this.autoFrame) this.frameStructures();
    this.renderWin();
  }

  /** Frame the structures. In display mode, orient to the v2 initial 3D camera: look
   *  along +Y with S/I (+Z) up (v2 right-side norm=(0,1,0) up=(0,0,1), transformed by the
   *  180-deg L/R,A/P content rotation -> +Y view). resetCamera preserves the direction+up
   *  and fits the distance. */
  private frameStructures(): void {
    if (this.displayView) {
      const cam = this.renderer.getActiveCamera();
      cam.setViewUp(0, 0, 1);
      const fp = cam.getFocalPoint();
      cam.setPosition(fp[0], fp[1] - 1, fp[2]); // camera on -Y -> view direction +Y
      this.renderer.resetCamera();
      cam.zoom(DISPLAY_ZOOM); // resetCamera fits loosely; zoom in so the meshes fill the view
      this.renderer.resetCameraClippingRange();
      return;
    }
    this.renderer.resetCamera();
    this.renderer.resetCameraClippingRange();
  }

  /** Apply per-structure color/opacity/visibility (called on toggles). */
  syncStructureProps(): void {
    for (const s of this.structures) {
      const a = this.structActors.get(s.id);
      if (!a) continue;
      const p = a.actor.getProperty();
      p.setColor(s.color[0], s.color[1], s.color[2]);
      p.setOpacity(s.opacity);
      // Contacts (type 13) are thin OPEN patches wound so their front faces point the wrong way;
      // render the OPPOSITE side (cull front, keep back) so they show on the -x carrier surface.
      const contacts = s.typeId === 13;
      p.setFrontfaceCulling(contacts);
      p.setBackfaceCulling(!contacts && s.opacity >= 1);
      a.actor.setVisibility(s.visible);
    }
    this.renderWin();
  }

  setMode(mode: Mode3D): void {
    this.mode = mode;
    this.applyMode();
    this.update();
  }

  /** Preop-plan trajectories: the insertion lines plus, with guidance on, the clock dials and
   *  the rest of IDL's _DrawTrajAccessaries. `abSegments` are the scala-tympani A/B measures.
   *  Rebuilt wholesale on any change — the desktop caches on a key, but these are a few dozen
   *  small actors and the toggles are user-paced. */
  setTrajectories(trajs: PlanTrajectory[], abSegments: [Vec3, Vec3][], opts: TrajectoryOpts): void {
    for (const a of this.trajActors) this.renderer.removeActor(a);
    const scene = buildTrajectoryScene(trajs, opts);
    this.trajActors = [...scene.actors, ...buildAbActors(abSegments)];
    this.trajLabels = scene.labels;
    for (const a of this.trajActors) this.renderer.addActor(a);
    this.renderWin();
  }

  /** Electrode contacts: spheres + a connecting polyline, with their numbers as 2D labels. */
  setMarkers(markers: Marker[]): void {
    for (const a of this.markerActors) this.renderer.removeActor(a);
    this.markerActors = buildMarkerActors(markers);
    for (const a of this.markerActors) this.renderer.addActor(a);
    this.markerLabels = markers
      .filter((m) => m.label)
      // White on a dark halo, as the desktop's contact billboards are (_update_3d_markers).
      .map((m) => ({
        text: m.label,
        pos: m.position,
        color: [1, 1, 1] as Vec3,
        halo: 'rgba(0,0,0,0.75)',
      }));
    this.renderWin();
  }

  /** Restore a saved 3D camera (the workspace's ui.camera3d block; desktop apply_ui_state).
   *  Call AFTER setStructures/setImage, whose resetCamera would otherwise override it. */
  setCamera(cam: {
    position: [number, number, number];
    focal: [number, number, number];
    view_up: [number, number, number];
    parallel_scale?: number;
  }): void {
    const c = this.renderer.getActiveCamera();
    c.setPosition(...cam.position);
    c.setFocalPoint(...cam.focal);
    c.setViewUp(...cam.view_up);
    if (cam.parallel_scale) c.setParallelScale(cam.parallel_scale);
    this.renderer.resetCameraClippingRange();
    this.renderWin();
  }

  setProjection(kind: 'parallel' | 'perspective'): void {
    this.renderer.getActiveCamera().setParallelProjection(kind === 'parallel');
    this.update();
  }

  /** The camera's parallel scale — the viewport half-height in mm. Use viewFit's
   *  parallelScaleFor to match a 2D pane's zoom (four_up_viewer._apply_3d_zoom).
   *
   *  No visible effect in perspective projection: vtk stores the value and it materializes on
   *  the next switch to parallel. */
  setParallelScale(scale: number): void {
    this.renderer.getActiveCamera().setParallelScale(scale);
    this.renderer.resetCameraClippingRange();
    this.renderWin();
  }

  /** Slide the camera so `world` is at the centre of the view, keeping the direction and the
   *  distance (four_up_viewer._center_3d_on: focal point and position get the same delta).
   *
   *  This also moves the orbit pivot, since onPointerMove rotates with azimuth/elevation —
   *  which turn about the focal point. That is the desktop's _style3d._pivot, for free. */
  centerOn(world: Vec3): void {
    const cam = this.renderer.getActiveCamera();
    const fp = cam.getFocalPoint();
    const pos = cam.getPosition();
    const d = [world[0] - fp[0], world[1] - fp[1], world[2] - fp[2]];
    cam.setFocalPoint(fp[0] + d[0], fp[1] + d[1], fp[2] + d[2]);
    cam.setPosition(pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]);
    this.renderer.resetCameraClippingRange();
    this.renderWin();
  }

  /** The full camera, for a takeover panel to snapshot and put back (render/viewScope.ts). */
  cameraState(): { position: Vec3; focal: Vec3; viewUp: Vec3; parallelScale: number } {
    const cam = this.renderer.getActiveCamera();
    return {
      position: [...cam.getPosition()] as Vec3,
      focal: [...cam.getFocalPoint()] as Vec3,
      viewUp: [...cam.getViewUp()] as Vec3,
      parallelScale: cam.getParallelScale(),
    };
  }

  setCameraState(s: { position: Vec3; focal: Vec3; viewUp: Vec3; parallelScale: number }): void {
    this.setCamera({
      position: s.position,
      focal: s.focal,
      view_up: s.viewUp,
      parallel_scale: s.parallelScale,
    });
  }

  private applyMode(): void {
    this.renderer.removeVolume(this.volume);
    this.renderer.removeActor(this.surfaceActor);
    if (this.mode === 'volume' || this.mode === 'mip') {
      if (this.mode === 'mip') {
        this.volumeMapper.setBlendModeToMaximumIntensity();
        this.volume.getProperty().setShade(false);
      } else {
        this.volumeMapper.setBlendModeToComposite();
        this.volume.getProperty().setShade(true);
      }
      this.renderer.addVolume(this.volume);
    } else if (this.mode === 'surface') {
      if (this.surfaceBuilt) this.renderer.addActor(this.surfaceActor);
      else void this.loadSurface(); // fetch the C++-built mesh, then add + render
    }
  }

  /** Fetch the isosurface mesh from the backend (C++ FlyingEdges) and display it. */
  private async loadSurface(): Promise<void> {
    if (!this.image || this.surfaceLoading) return;
    this.surfaceLoading = true;
    try {
      const mesh = await fetchSurface(
        this.image.id,
        this.image.surfaceThreshold[0],
        this.image.surfaceThreshold[1],
      );
      this.surfaceMapper.setInputData(meshToPolyData(mesh));
      this.surfaceBuilt = true;
      if (this.mode === 'surface') {
        this.renderer.addActor(this.surfaceActor);
        // The mesh arrived after setImage's resetCamera (async), so frame it now that it exists
        // — unless someone has set the camera deliberately in the meantime (a plan's saved
        // ui.camera3d, or a takeover panel's fit), which this would otherwise discard.
        if (this.autoFrame) this.renderer.resetCamera();
        this.renderWin();
      }
    } finally {
      this.surfaceLoading = false;
    }
  }

  private setupOrientationMarker(): void {
    if (this.orientation) return;
    const axes = vtkAxesActor.newInstance();
    this.orientation = vtkOrientationMarkerWidget.newInstance({
      actor: axes,
      interactor: this.grw.getInteractor(),
    });
    this.orientation.setEnabled(true);
    this.orientation.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_LEFT);
    this.orientation.setViewportSize(0.15);
  }

  update(): void {
    if (this.container.clientWidth < 2 || this.container.clientHeight < 2) return; // WebGL needs a sized surface
    if (!this.image) {
      // Still match the canvas to the host. The render window is created before the layout
      // settles, so without this an empty view keeps whatever size it guessed then — which
      // overflows its host and stretches the page instead of fitting the pane.
      this.grw.resize();
      this.renderWin();
      return;
    }
    const c = this.vs.crosshair as Vec3;
    const arm = 20;
    const dirs: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    this.crossActors.forEach((actor, i) => {
      const d = dirs[i];
      const p0: Vec3 = [c[0] - d[0] * arm, c[1] - d[1] * arm, c[2] - d[2] * arm];
      const p1: Vec3 = [c[0] + d[0] * arm, c[1] + d[1] * arm, c[2] + d[2] * arm];
      (actor.getMapper() as ReturnType<typeof vtkMapper.newInstance>).setInputData(lineData(p0, p1));
    });
    this.grw.resize();
    this.renderWin();
  }

  private renderWin(): void {
    this.grw.getRenderWindow().render();
    this.drawLabels();
  }

  /** Project the trajectory/guidance label anchors and draw them over the GL canvas. vtk.js
   *  has no text actor, so this replaces the desktop's vtkBillboardTextActor3D labels. */
  private drawLabels(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.labelCanvas.width !== Math.round(w * dpr) || this.labelCanvas.height !== Math.round(h * dpr)) {
      this.labelCanvas.width = Math.round(w * dpr);
      this.labelCanvas.height = Math.round(h * dpr);
    }
    const g = this.lctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const labels = [...this.trajLabels, ...this.markerLabels];
    if (!labels.length) return;
    g.font = '12px sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (const l of labels) {
      const nd = this.renderer.worldToNormalizedDisplay(l.pos[0], l.pos[1], l.pos[2], w / h);
      if (nd[2] < 0 || nd[2] > 1) continue; // outside the clipping range
      const x = nd[0] * w + 4;
      const y = (1 - nd[1]) * h; // normalized display is y-up, canvas is y-down
      if (x < -40 || x > w + 40 || y < -20 || y > h + 20) continue;
      g.lineWidth = 3; // halo, so a dark label still reads over dark anatomy
      g.strokeStyle = l.halo ?? 'rgba(255,255,255,0.7)';
      g.strokeText(l.text, x, y);
      g.fillStyle = `rgb(${l.color.map((c) => Math.round(c * 255)).join(',')})`;
      g.fillText(l.text, x, y);
    }
  }

  // --- desktop 3D mouse model -----------------------------------------------
  private displayXY(e: PointerEvent): [number, number] {
    const r = this.container.getBoundingClientRect();
    const view = this.grw.getRenderWindow().getViews()[0];
    const [vw, vh] = view.getSize();
    const dprX = vw / r.width;
    const dprY = vh / r.height;
    return [(e.clientX - r.left) * dprX, vh - 1 - (e.clientY - r.top) * dprY]; // device px, y up
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.image) return;
    this.container.setPointerCapture?.(e.pointerId);
    this.drag = { button: e.button, x: e.clientX, y: e.clientY };
    if (e.button === 0) this.pick(e); // left: pick surface -> crosshair
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    const cam = this.renderer.getActiveCamera();
    if (this.drag.button === 2) {
      // right: rotate (orbit)
      cam.azimuth(-dx * ROT_RATE);
      cam.elevation(dy * ROT_RATE);
      cam.orthogonalizeViewUp();
      this.renderer.resetCameraClippingRange();
      this.renderWin();
    } else if (this.drag.button === 1) {
      this.pan(dx, dy);
    } else if (this.drag.button === 0) {
      this.pick(e); // left drag keeps picking (continuous crosshair move)
    }
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.drag) this.container.releasePointerCapture?.(e.pointerId);
    this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    const cam = this.renderer.getActiveCamera();
    const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12; // >1 = zoom in
    if (cam.getParallelProjection()) cam.setParallelScale(cam.getParallelScale() / factor);
    else cam.dolly(factor);
    this.renderer.resetCameraClippingRange();
    this.renderWin();
    e.preventDefault();
  };

  private pan(dxPx: number, dyPx: number): void {
    const cam = this.renderer.getActiveCamera();
    const h = this.container.clientHeight || 1;
    const up = cam.getViewUp() as Vec3;
    const dop = cam.getDirectionOfProjection() as Vec3;
    const right: Vec3 = [
      dop[1] * up[2] - dop[2] * up[1],
      dop[2] * up[0] - dop[0] * up[2],
      dop[0] * up[1] - dop[1] * up[0],
    ];
    let scale: number;
    if (cam.getParallelProjection()) scale = (cam.getParallelScale() * 2) / h;
    else {
      const fp = cam.getFocalPoint();
      const p = cam.getPosition();
      const dist = Math.hypot(fp[0] - p[0], fp[1] - p[1], fp[2] - p[2]);
      scale = (2 * dist * Math.tan((cam.getViewAngle() * Math.PI) / 360)) / h;
    }
    const mv: Vec3 = [
      -dxPx * scale * right[0] + dyPx * scale * up[0],
      -dxPx * scale * right[1] + dyPx * scale * up[1],
      -dxPx * scale * right[2] + dyPx * scale * up[2],
    ];
    const fp = cam.getFocalPoint();
    const p = cam.getPosition();
    cam.setFocalPoint(fp[0] + mv[0], fp[1] + mv[1], fp[2] + mv[2]);
    cam.setPosition(p[0] + mv[0], p[1] + mv[1], p[2] + mv[2]);
    this.renderWin();
  }

  /** GPU depth pick (like the desktop z-buffer pick): the surface point under the cursor ->
   *  move the crosshair. O(1) on the GPU regardless of mesh size, unlike a ray-cast picker. */
  private async pick(e: PointerEvent): Promise<void> {
    if (!this.onPick || this.picking) return;
    this.picking = true;
    try {
      const [x, y] = this.displayXY(e);
      const apiRW = this.grw.getApiSpecificRenderWindow();
      this.selector.setOpenGLRenderWindow(apiRW);
      this.selector.setArea(x, y, x, y);
      const nodes = await this.selector.selectAsync(this.renderer, x, y, x, y);
      const wp = nodes?.[0]?.getProperties?.().worldPosition as Vec3 | undefined;
      if (wp) this.onPick([wp[0], wp[1], wp[2]]);
    } finally {
      this.picking = false;
    }
  }

  private preventCtx = (e: Event) => e.preventDefault();

  /** Capture the current 3D view as a PNG data URL (for the PDF report). */
  async captureImage(): Promise<string> {
    const view = this.grw.getApiSpecificRenderWindow();
    const p = view.captureNextImage('image/png');
    this.grw.getRenderWindow().render();
    return (await p) ?? '';
  }

  /** Four report screenshots (v3 _create3DScreenshots): [modiolus+scala top, modiolus top,
   *  modiolus+scala bottom, modiolus bottom] — each with the implant, framed along ±Y. Restores
   *  the camera + structure visibility afterwards. */
  async capturePdf3D(): Promise<string[]> {
    const cam = this.renderer.getActiveCamera();
    const sp = cam.getPosition() as Vec3;
    const sf = cam.getFocalPoint() as Vec3;
    const su = cam.getViewUp() as Vec3;
    // Report snapshots: black background + no 3D crosshair lines (the corner axis marker stays).
    const saveBg = this.renderer.getBackground() as Vec3;
    const saveCross = this.crossActors.map((a) => !!a.getVisibility());
    this.renderer.setBackground(0, 0, 0);
    this.crossActors.forEach((a) => a.setVisibility(false));
    const saveVis = new Map<string, boolean>();
    for (const s of this.structures) {
      const a = this.structActors.get(s.id);
      if (a) saveVis.set(s.id, !!a.actor.getVisibility());
    }
    const show = (pred: (s: Structure) => boolean) => {
      for (const s of this.structures) {
        const a = this.structActors.get(s.id);
        if (a) a.actor.setVisibility(pred(s));
      }
    };
    const framed = (dirY: number) => {
      cam.setViewUp(0, 0, 1);
      const fp = cam.getFocalPoint();
      cam.setPosition(fp[0], fp[1] + dirY, fp[2]);
      this.renderer.resetCamera();
      cam.zoom(PDF_SHOT_ZOOM); // fill the snapshot frame (resetCamera fits loosely)
      this.renderer.resetCameraClippingRange();
    };
    const isImplant = (s: Structure) => s.group === 'implants';
    const shots: string[] = ['', '', '', ''];
    show((s) => isImplant(s) || s.typeId === 18 || s.typeId === 5 || s.typeId === 6); // + scala
    framed(1);
    shots[0] = await this.captureImage();
    framed(-1);
    shots[2] = await this.captureImage();
    show((s) => isImplant(s) || s.typeId === 18); // modiolus only
    framed(1);
    shots[1] = await this.captureImage();
    framed(-1);
    shots[3] = await this.captureImage();
    // restore
    for (const s of this.structures) {
      const a = this.structActors.get(s.id);
      if (a && saveVis.has(s.id)) a.actor.setVisibility(!!saveVis.get(s.id));
    }
    cam.setPosition(sp[0], sp[1], sp[2]);
    cam.setFocalPoint(sf[0], sf[1], sf[2]);
    cam.setViewUp(su[0], su[1], su[2]);
    this.renderer.setBackground(saveBg[0], saveBg[1], saveBg[2]);
    this.crossActors.forEach((a, i) => a.setVisibility(saveCross[i]));
    this.renderer.resetCameraClippingRange();
    this.renderWin();
    return shots;
  }

  delete(): void {
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('contextmenu', this.preventCtx);
    this.orientation?.setEnabled(false);
    this.labelCanvas.remove();
    this.grw.delete();
  }
}

// A 2-point line as vtkPolyData.
function lineData(p0: Vec3, p1: Vec3): vtkPolyData {
  const pd = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  pts.setData(Float32Array.from([...p0, ...p1]), 3);
  pd.setPoints(pts);
  const lines = vtkCellArray.newInstance();
  lines.setData(Uint16Array.from([2, 0, 1]));
  pd.setLines(lines);
  return pd;
}
