// Imperative controller for one MPR pane, GPU-rendered with a 2D overlay HUD.
//
// Render: each slot (top, optional bottom) is a 3D texture (vtkImageData) sliced by a
// world-space plane (vtkImageResliceMapper, hardware trilinear). Two slots blend by drawing
// the OPAQUE bottom, then the TOP at opacity = blendAlpha nudged slightly toward the camera
// (avoids coplanar z-fighting): display = top*alpha + bottom*(1-alpha), the desktop blend.
// Each actor's userMatrix = inv(image.worldMatrix), so manual registration (which edits the
// bottom image's world matrix) moves that slot live.
//
// Overlay: a 2D canvas over the WebGL canvas draws the desktop HUD in CSS pixels.
//
// Interaction (desktop-exact): left body = crosshair (dbl = recenter all); left/right 20px
// edge = zoom/slice; bottom 20px edge = blend factor; middle = pan; right = W/L; wheel = slice.

import '@kitware/vtk.js/Rendering/Profiles/Volume';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow';
import vtkImageResliceMapper from '@kitware/vtk.js/Rendering/Core/ImageResliceMapper';
import vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';

import type { Image } from '../core/image';
import type { ViewName, ViewState } from '../core/scene';
import { viewAxes } from '../core/scene';
import { axisLetter } from '../core/geometry';
import {
  applyToPoint,
  applyToVector,
  diag,
  invert,
  mul,
  rotation,
  translation,
  vadd,
  vcross,
  vdot,
  vscale,
  vsub,
  type Mat4,
  type Vec3,
} from '../core/mat4';
import type { Structure } from '../core/structure';
import { createOverlay, type OverlayMethod, type OverlayMethodId, type SliceView } from './overlay';
import { buildVolume } from './volumeData';
import { buildUnitGrid, resliceToScalars, toColMajor } from './reslice';

const HOT = 20;
const SLICE_DRAG_PX = 4;
const CROSS_ARM = 10;
const DBL_MS = 400;
const DBL_PX = 6;
const CAM_DIST = 1000;
const NUDGE = 0.05; // mm: push the top slice toward the camera so it composites over the bottom
const NICE_MM = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const ZOOM_LEVELS = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const RED = '#ff2a2a';
const ZONE = '#737373';

type Mode = 'cross' | 'zoom' | 'slice' | 'pan' | 'wl' | 'blend' | 'reg' | 'fg_lo' | 'fg_hi' | 'crop' | 'overlay' | null;
export type Tool2D = 'position' | 'overlay' | 'measure' | 'crop' | 'register';
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** A world-space line the plan draws on every slice (trajectory display line, A/B measure). */
export interface PlanSegment {
  p0: Vec3;
  p1: Vec3;
  color: [number, number, number];
  width: number;
}

/** A labelled world point drawn in 2D and 3D — the desktop's marker layer, used for a localized
 *  lead's electrode contacts (four_up_viewer.set_leads). Whether a contact shows on a given slice
 *  is Point projection's call; see drawMarkers. */
export interface Marker {
  position: Vec3;
  label: string;
  selected: boolean;
}

const MARKER = '#ffff00'; // the desktop's yellow contacts — _lead_marker_list's (1, 1, 0)
const MARKER_SEL = '#ff4040';
// reslice_view: the plus-sign half-arm and the dotted connecting line, both in SCREEN pixels, so
// the glyphs keep their size through a zoom (the desktop scales them by mm-per-pixel for the same
// reason). _MARKER_ARM_PX = 5, (_DOT_ON_PX, _DOT_PERIOD_PX) = (1, 4).
const MARKER_ARM_PX = 5;
const DOT_ON_PX = 1;
const DOT_PERIOD_PX = 4;

/** scalar -> [r,g,b] via the image's W/L window + optional colormap (for CPU compositing). */
function colorMapper(image: Image): (v: number) => [number, number, number] {
  const lo = image.level - image.window / 2;
  const hi = image.level + image.window / 2;
  const inv = 1 / Math.max(hi - lo, 1e-6);
  const cm = image.colormap;
  return (v: number) => {
    let t = (v - lo) * inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (cm) {
      const e = cm[Math.round(t * 255)];
      return [e[0], e[1], e[2]];
    }
    const g = Math.round(t * 255);
    return [g, g, g];
  };
}

interface Measure {
  mode: 'free' | 'ortho' | 'angle';
  p0: Vec3;
  p1: Vec3;
  pta: Vec3 | null;
  phase: 'p1' | 'vertex' | 'arm2' | 'done';
}

interface RegCtx {
  img: Image;
  mode: 'translate' | 'rotate' | 'scale';
  x0: number;
  y0: number;
  u: Vec3;
  v: Vec3;
  o: Vec3;
  px: number;
  c: Vec3; // pivot (world)
  axis: Vec3;
  shift: number;
  angle: number;
  scale: number;
}

interface Slot {
  mapper: ReturnType<typeof vtkImageResliceMapper.newInstance>;
  actor: ReturnType<typeof vtkImageSlice.newInstance>;
  plane: ReturnType<typeof vtkPlane.newInstance>;
  ctf: ReturnType<typeof vtkColorTransferFunction.newInstance>;
  opacity: ReturnType<typeof vtkPiecewiseFunction.newInstance>;
}

export class ReslicePane {
  private grw: ReturnType<typeof vtkGenericRenderWindow.newInstance>;
  private renderer: ReturnType<
    ReturnType<typeof vtkGenericRenderWindow.newInstance>['getRenderer']
  >;
  private topSlot: Slot;
  private botSlot: Slot;
  private top: Image | null = null;
  private bottom: Image | null = null;
  private volCache = new Map<string, ReturnType<typeof buildVolume>>();
  readonly view: ViewName;
  private vs: ViewState;
  private container: HTMLElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;

  center: Vec3 = [0, 0, 0];
  overlaysVisible = true;
  compact = false; // display panes: hide corner buttons + hot-zone dividers
  sliceByVoxel = false; // display panes: wheel/scroll advances 1 image slice (voxel), not vs.sliceStep
  crosshairStyle: 'cross' | 'dashed' = 'cross';
  tool: Tool2D = 'position';
  regScaling = false; // atlas mode: middle-drag = scale (else pan)
  private reg: RegCtx | null = null;
  structures: Structure[] = []; // result-display meshes (drawn as a 2D cross-section overlay)
  private planSegments: PlanSegment[] = []; // plan trajectory lines + A/B measures
  private markers: Marker[] = []; // electrode contacts (labelled, connected in order)
  private pointProjection = true; // Display: Point projection — gates the marker layer (drawMarkers)
  // The 2D structure overlay is drawn by a pluggable OverlayMethod (mesh-projection fill, contour
  // outline, mask, ...) so the technique can be swapped live from the UI (setOverlayMethod). The
  // method owns its own resources (cutters, caches, GPU layers); this pane just feeds it the
  // structures + per-frame slice geometry and calls draw() under the HUD.
  private overlayMethodId: OverlayMethodId = 'mask';
  private overlayMethod: OverlayMethod = createOverlay('mask');
  private overlayFillAlpha: number | null = null;
  private cropResize: Set<string> | null = null; // dragged crop edges
  private cropRedPx: [number, number, number, number] | null = null; // box rect in canvas px
  private measures: Measure[] = [];
  private measureActive: Measure | null = null;
  private measPlane: string | null = null; // (radiological, slice-offset); measures drop on change
  // overlay tool: CPU stencil composite of top/bottom (desktop technique)
  private overlayMode: 'checker' | 'patch' | null = null;
  private overlayCenter: [number, number] = [0, 0]; // CSS px, y-up
  private overlayCanvas = document.createElement('canvas'); // offscreen composite
  private gridCache = new Map<string, ReturnType<typeof buildUnitGrid>>();
  fgPreview = false; // crop-tool fg drag active on any pane -> show the red in-range mask
  onFgPreview: ((on: boolean) => void) | null = null;

  onCrosshair: (() => void) | null = null;
  onRecenterAll: (() => void) | null = null;
  onChanged: (() => void) | null = null;
  onMaximize: (() => void) | null = null;
  onRegChange: (() => void) | null = null;

  private w = 0;
  private h = 0;
  private px = 1;
  private u: Vec3 = [1, 0, 0];
  private v: Vec3 = [0, 1, 0];
  private n: Vec3 = [0, 0, 1];
  private o: Vec3 = [0, 0, 0];

  private mode: Mode = null;
  private last: [number, number] = [0, 0];
  private lastPress = { t: 0, x: 0, y: 0, button: -1 };
  private buttons: { rect: Rect; act: () => void }[] = [];

  constructor(container: HTMLElement, view: ViewName, vs: ViewState) {
    this.container = container;
    this.view = view;
    this.vs = vs;
    container.style.position = 'relative';
    this.grw = vtkGenericRenderWindow.newInstance({ background: [0, 0, 0] });
    this.grw.setContainer(container as HTMLElement);
    this.renderer = this.grw.getRenderer();
    this.grw.getInteractor().setInteractorStyle(null as never);

    this.botSlot = this.makeSlot();
    this.topSlot = this.makeSlot(); // added after bottom -> drawn on top
    this.renderer.addActor(this.botSlot.actor);
    this.renderer.addActor(this.topSlot.actor);
    this.botSlot.actor.setVisibility(false);

    this.overlay = document.createElement('canvas');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);
    container.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;

    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    container.addEventListener('contextmenu', this.preventCtx);
  }

  private makeSlot(): Slot {
    const mapper = vtkImageResliceMapper.newInstance();
    const plane = vtkPlane.newInstance();
    mapper.setSlicePlane(plane);
    const actor = vtkImageSlice.newInstance();
    actor.setMapper(mapper);
    return {
      mapper,
      actor,
      plane,
      ctf: vtkColorTransferFunction.newInstance(),
      opacity: vtkPiecewiseFunction.newInstance(),
    };
  }

  private volumeOf(image: Image): ReturnType<typeof buildVolume> {
    let v = this.volCache.get(image.id);
    if (!v) {
      v = buildVolume(image);
      this.volCache.set(image.id, v);
    }
    return v;
  }

  /** Assign the top/bottom slot images (from the scene). */
  setSlots(top: Image | null, bottom: Image | null): void {
    const firstLoad = this.top === null && top !== null;
    this.top = top;
    this.bottom = bottom && bottom !== top ? bottom : null;
    if (top) this.topSlot.mapper.setInputData(this.volumeOf(top));
    if (this.bottom) this.botSlot.mapper.setInputData(this.volumeOf(this.bottom));
    if (firstLoad) this.center = [...(this.vs.crosshair as Vec3)];
    this.update();
  }

  private planeOrigin(): Vec3 {
    const depth = vdot(vsub(this.vs.crosshair as Vec3, this.center), this.n);
    return vadd(this.center, vscale(this.n, depth));
  }

  update(): void {
    if (!this.top) {
      // Keep the canvas matched to the host even with no image: the render window is created
      // before the layout settles, so an empty pane would otherwise hold the size it guessed
      // then and overflow its cell (see View3D.update for the same guard).
      if (this.container.clientWidth > 1 && this.container.clientHeight > 1) this.grw.resize();
      return;
    }
    this.grw.resize();
    this.w = this.container.clientWidth;
    this.h = this.container.clientHeight;
    if (this.w < 2 || this.h < 2) return;

    [this.u, this.v, this.n] = viewAxes(this.view, this.vs.radiological, this.vs.orientation);
    this.o = this.planeOrigin();
    this.px = this.vs.fovMm / this.vs.zoom / this.h;
    this.syncMeasures(); // drop measurements if the slice/orientation changed
    const sgn = vdot(vcross(this.v, this.n), this.u) >= 0 ? 1 : -1;

    const blending = this.bottom !== null;
    const alpha = this.vs.blendAlpha;
    // Overlay tool: CPU stencil composite replaces the GPU blend for this pane (desktop
    // technique) — hide the GPU slices, render the composite onto the overlay canvas.
    const overlayTool = this.tool === 'overlay';
    const overlayActive = overlayTool && blending && this.overlayMode !== null;
    // Overlay + crop tools show the top image alone (crop shows crop-dim + a red fg preview;
    // overlay shows the checker/patch while dragging). Other tools blend if a bottom is set.
    const showBlend = blending && !overlayTool && this.tool !== 'crop';
    // top: nudged toward the camera so it composites over the bottom
    const oTop = showBlend ? vadd(this.o, vscale(this.n, sgn * NUDGE)) : this.o;
    this.applySlot(this.topSlot, this.top, oTop, showBlend ? alpha : 1);
    this.topSlot.actor.setVisibility(!overlayActive);
    this.botSlot.actor.setVisibility(showBlend && !overlayActive);
    if (showBlend) this.applySlot(this.botSlot, this.bottom!, this.o, 1);

    const cam = this.renderer.getActiveCamera();
    const pos = vadd(this.o, vscale(this.n, sgn * CAM_DIST));
    cam.setParallelProjection(true);
    cam.setFocalPoint(this.o[0], this.o[1], this.o[2]);
    cam.setPosition(pos[0], pos[1], pos[2]);
    cam.setViewUp(this.v[0], this.v[1], this.v[2]);
    cam.setParallelScale(this.vs.fovMm / this.vs.zoom / 2);
    cam.setClippingRange(CAM_DIST - 500, CAM_DIST + 500);
    this.grw.getRenderWindow().render();

    this.overlayActive = overlayActive;
    if (overlayActive) this.computeOverlayComposite();
    this.drawOverlay();
  }

  private overlayActive = false;

  private gridOf(image: Image): ReturnType<typeof buildUnitGrid> {
    let gr = this.gridCache.get(image.id);
    if (!gr) {
      gr = buildUnitGrid(image.pixels!, image.size);
      this.gridCache.set(image.id, gr);
    }
    return gr;
  }

  /** CPU stencil composite: reslice top+bottom to the pane raster, colour-map, and select
   *  per-pixel via a checkerboard (quadrants split at the cursor) or a patch window. */
  private computeOverlayComposite(): void {
    const top = this.top!;
    const bot = this.bottom!;
    const w = Math.max(1, Math.round(this.w));
    const h = Math.max(1, Math.round(this.h));
    const ts = resliceToScalars(this.gridOf(top), top, this.view, this.vs, w, h, this.o);
    const bs = resliceToScalars(this.gridOf(bot), bot, this.view, this.vs, w, h, this.o);
    const cvs = this.overlayCanvas;
    cvs.width = w;
    cvs.height = h;
    const cctx = cvs.getContext('2d')!;
    const img = cctx.createImageData(w, h);
    const data = img.data;
    const [ccx0, ccy0] = this.overlayCenter; // CSS px, y-up
    const ccx = ccx0;
    const ccy = h - 1 - ccy0; // -> raster/canvas y-down
    const patchHalf = Math.round(Math.min(w, h) * 0.1); // desktop: 0.2*min/2
    const topMap = colorMapper(top);
    const botMap = colorMapper(bot);
    for (let cy = 0; cy < h; cy++) {
      const jrow = (h - 1 - cy) * w; // reslice raster: j=0 is bottom
      for (let cx = 0; cx < w; cx++) {
        let showTop: boolean;
        if (this.overlayMode === 'checker') {
          showTop = cx < ccx !== cy < ccy; // XOR quadrants split at the cursor
        } else {
          const inPatch = Math.abs(cx - ccx) <= patchHalf && Math.abs(cy - ccy) <= patchHalf;
          showTop = !inPatch; // patch peeks the bottom image
        }
        const v = showTop ? ts[jrow + cx] : bs[jrow + cx];
        const rgb = showTop ? topMap(v) : botMap(v);
        const o = (cy * w + cx) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
    cctx.putImageData(img, 0, 0);
  }

  private applySlot(slot: Slot, image: Image, origin: Vec3, opacity: number): void {
    // The slice plane must be given in the IMAGE's own coordinates, not world: vtk.js's
    // ImageResliceMapper cuts the input's bounds with it (updateResliceGeometry) and only then
    // maps the result out through the actor's user matrix. The two frames coincide while
    // worldMatrix is identity — true for every plain load and unregistered plan, which is why
    // this went unnoticed — but NOT for a .cdb, whose pair is re-framed onto the atlas; there the
    // plane landed in the wrong place and panes showed a sliver of volume, or none.
    const w = image.worldMatrix; // world -> image-world
    const po = applyToPoint(w, origin);
    const pn = applyToVector(w, this.n);
    slot.plane.setOrigin(po[0], po[1], po[2]);
    slot.plane.setNormal(pn[0], pn[1], pn[2]);
    // registration: place the volume by inv(worldMatrix) (identity when unregistered)
    slot.actor.setUserMatrix(toColMajor(invert(image.worldMatrix)));
    const prop = slot.actor.getProperty();
    // crop-tool fg drag: recolor the in-range band red in the CTF (GPU, instant), like the
    // desktop's red mask — no CPU reslice.
    const fgRed = image === this.top && this.tool === 'crop' && this.fgPreview;
    this.buildCtf(slot.ctf, image, fgRed);
    prop.setRGBTransferFunction(0, slot.ctf);
    prop.setUseLookupTableScalarRange(true);
    // Foreground transparency applies only OUTSIDE the crop tool (desktop: crop mode shows
    // the full image + a red preview; the fg window takes effect on leaving the tool).
    this.buildFgOpacity(slot.opacity, image, this.tool !== 'crop');
    prop.setPiecewiseFunction(0, slot.opacity);
    prop.setOpacity(opacity);
    if (image.interp === 'nearest') prop.setInterpolationTypeToNearest();
    else prop.setInterpolationTypeToLinear();
  }

  private buildCtf(
    ctf: ReturnType<typeof vtkColorTransferFunction.newInstance>,
    image: Image,
    fgRed = false,
  ): void {
    const lo = image.level - image.window / 2;
    const hi = image.level + image.window / 2;
    ctf.removeAllPoints();
    const cm = image.colormap;
    const grayAt = (x: number): [number, number, number] => {
      let t = (x - lo) / (hi - lo);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (cm) {
        const e = cm[Math.round(t * 255)];
        return [e[0] / 255, e[1] / 255, e[2] / 255];
      }
      return [t, t, t];
    };
    if (fgRed) {
      // gray/colormap outside the fg window, solid red inside [flo,fhi] (desktop red mask)
      const [flo, fhi] = image.fgWindow;
      const N = 64;
      for (let i = 0; i <= N; i++) {
        const x = lo + ((hi - lo) * i) / N;
        if (x >= flo && x <= fhi) ctf.addRGBPoint(x, 1, 0, 0);
        else {
          const c = grayAt(x);
          ctf.addRGBPoint(x, c[0], c[1], c[2]);
        }
      }
      return;
    }
    if (cm) {
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        ctf.addRGBPoint(lo + t * (hi - lo), cm[i][0] / 255, cm[i][1] / 255, cm[i][2] / 255);
      }
    } else {
      ctf.addRGBPoint(lo, 0, 0, 0);
      ctf.addRGBPoint(hi, 1, 1, 1);
    }
  }

  /** Foreground intensity window -> per-voxel opacity (voxels outside [lo,hi] transparent).
   *  `apply` false forces fully opaque (crop mode). */
  private buildFgOpacity(
    pwf: ReturnType<typeof vtkPiecewiseFunction.newInstance>,
    image: Image,
    apply: boolean,
  ): void {
    const [lo, hi] = image.fgWindow;
    pwf.removeAllPoints();
    if (!apply || (lo <= image.valueMin && hi >= image.valueMax)) {
      pwf.addPoint(image.valueMin, 1); // full range -> fully opaque
      pwf.addPoint(image.valueMax, 1);
    } else {
      const eps = Math.max((image.valueMax - image.valueMin) * 1e-4, 1e-3);
      pwf.addPoint(lo - eps, 0);
      pwf.addPoint(lo, 1);
      pwf.addPoint(hi, 1);
      pwf.addPoint(hi + eps, 0);
    }
  }

  // --- overlay HUD (CSS px, canvas y-down) ----------------------------------
  private toCanvas(world: Vec3): [number, number] {
    const du = vdot(vsub(world, this.o), this.u);
    const dv = vdot(vsub(world, this.o), this.v);
    return [(this.w - 1) / 2 + du / this.px, (this.h - 1) / 2 - dv / this.px];
  }

  private drawOverlay(): void {
    const { octx: g, w, h } = this;
    const dpr = window.devicePixelRatio || 1;
    if (this.overlay.width !== Math.round(w * dpr) || this.overlay.height !== Math.round(h * dpr)) {
      this.overlay.width = Math.round(w * dpr);
      this.overlay.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    this.buttons = [];
    if (this.overlayActive) g.drawImage(this.overlayCanvas, 0, 0, w, h); // CPU composite = the image
    this.overlayMethod.draw(g, this.sliceView()); // structure cross-section overlay, under the HUD
    this.drawPlanSegments(g); // plan trajectory lines + A/B measures, over the cross-sections
    this.drawMarkers(g); // electrode contacts
    if (!this.overlaysVisible) return;

    if (this.tool === 'crop') this.drawCropDim(g); // dim outside the box, under the HUD
    if (!this.compact) this.drawHotZones(g);
    this.drawColorBar(g);
    this.drawCrosshair(g);
    this.drawLetters(g);
    this.drawScaleBar(g);
    if (!this.compact) this.drawCornerButtons(g);
    this.drawViewName(g);
    if (this.tool === 'register' && this.bottom) this.drawRegistration(g);
    if (this.tool === 'crop') this.drawCropBox(g);
    if (this.tool === 'measure') this.drawMeasures(g);
    if (this.overlayActive) this.drawOverlayBorders(g);
  }

  /** Plan trajectory lines + A/B measure segments, projected onto the slice plane. */
  private drawPlanSegments(g: CanvasRenderingContext2D): void {
    if (!this.planSegments.length) return;
    g.lineCap = 'round';
    for (const s of this.planSegments) {
      const [x0, y0] = this.toCanvas(s.p0);
      const [x1, y1] = this.toCanvas(s.p1);
      g.strokeStyle = `rgb(${s.color.map((c) => Math.round(c * 255)).join(',')})`;
      g.lineWidth = s.width;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }

  /** Electrode contacts, a port of reslice_view._update_markers' marker layer.
   *
   *  Each contact is a PLUS-SIGN, not a dot, and the contacts are joined in order by a DOTTED
   *  line — the desktop dots rather than dashes because dashes read badly through the plus-signs.
   *
   *  Point projection decides what a slice shows, and it is the whole point of the layer:
   *    off — only the contacts within half a slice step of THIS plane draw, so a contact appears
   *          as you scroll onto it and the panes tell you where in the array you are; and no
   *          connecting line at all (IDL draws none with projection off).
   *    on  — every contact is projected onto every slice, so the whole array reads at once, and
   *          the connecting line joins them.
   *  The web previously drew the projected form unconditionally, with a solid line. */
  private drawMarkers(g: CanvasRenderingContext2D): void {
    if (!this.markers.length) return;
    const half = this.vs.sliceStep / 2;
    const shown: { m: Marker; x: number; y: number }[] = [];
    for (const m of this.markers) {
      if (!this.pointProjection && Math.abs(vdot(vsub(m.position, this.o), this.n)) > half) continue;
      const [x, y] = this.toCanvas(m.position);
      shown.push({ m, x, y });
    }
    if (!shown.length) return;
    g.lineCap = 'butt'; // drawPlanSegments leaves it 'round', which fattens the 1px dots

    // Each segment is its own path so the dash phase restarts at every contact, as _dash_segment
    // does — the dots then land ON the contacts rather than drifting along the array.
    if (this.pointProjection && shown.length >= 2) {
      g.strokeStyle = MARKER;
      g.lineWidth = 1;
      g.setLineDash([DOT_ON_PX, DOT_PERIOD_PX - DOT_ON_PX]);
      for (let i = 1; i < shown.length; i++) {
        g.beginPath();
        g.moveTo(shown[i - 1].x, shown[i - 1].y);
        g.lineTo(shown[i].x, shown[i].y);
        g.stroke();
      }
      g.setLineDash([]);
    }

    g.strokeStyle = MARKER;
    g.lineWidth = 2;
    g.beginPath();
    for (const { x, y } of shown) {
      g.moveTo(x - MARKER_ARM_PX, y);
      g.lineTo(x + MARKER_ARM_PX, y);
      g.moveTo(x, y - MARKER_ARM_PX);
      g.lineTo(x, y + MARKER_ARM_PX);
    }
    g.stroke();

    // Not the desktop's: it rings the selected contact in its Electrode panel, not here. Kept
    // because the web's electrode table centres AND selects, and the ring is what answers "which
    // row am I looking at" in the panes.
    const sel = shown.find((s) => s.m.selected);
    if (sel) {
      g.strokeStyle = MARKER_SEL;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(sel.x, sel.y, MARKER_ARM_PX + 2, 0, 2 * Math.PI);
      g.stroke();
    }

    // White, left of the plus and vertically centred on it (_set_marker_texts' _HaloText).
    g.font = '12px sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.lineWidth = 2.5; // halo, so the number reads over bright bone
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    for (const { m, x, y } of shown) {
      if (!m.label) continue;
      g.strokeText(m.label, x + MARKER_ARM_PX + 3, y);
      g.fillText(m.label, x + MARKER_ARM_PX + 3, y);
    }
  }

  /** Divider lines marking the checker split / patch window (the desktop draws none, so
   *  they're added here for clarity): a haloed yellow line. */
  private drawOverlayBorders(g: CanvasRenderingContext2D): void {
    const cx = this.overlayCenter[0];
    const cyTop = this.h - 1 - this.overlayCenter[1]; // canvas y-down
    const stroke = (draw: () => void) => {
      g.lineWidth = 3.5;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      draw();
      g.lineWidth = 1.5;
      g.strokeStyle = '#ffdd33';
      draw();
    };
    if (this.overlayMode === 'checker') {
      stroke(() => {
        g.beginPath();
        g.moveTo(cx, 0);
        g.lineTo(cx, this.h);
        g.moveTo(0, cyTop);
        g.lineTo(this.w, cyTop);
        g.stroke();
      });
    } else {
      const half = Math.round(Math.min(this.w, this.h) * 0.1); // match the composite patch
      stroke(() => g.strokeRect(cx - half, cyTop - half, 2 * half, 2 * half));
    }
  }

  /** Project the crop box onto the current slice: rect in canvas px + whether the slice
   *  is within the box's through-plane range. */
  private projectBox(box: number[]): { x0: number; x1: number; y0: number; y1: number; inside: boolean } {
    const img = this.top!;
    const xs = [box[0] - 0.5, box[1] + 0.5];
    const ys = [box[2] - 0.5, box[3] + 0.5];
    const zs = [box[4] - 0.5, box[5] + 0.5];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    let minN = Infinity, maxN = -Infinity;
    for (const i of xs)
      for (const j of ys)
        for (const k of zs) {
          const wp = img.pixelToWorld([i, j, k]);
          const du = vdot(vsub(wp, this.o), this.u);
          const dv = vdot(vsub(wp, this.o), this.v);
          const dn = vdot(vsub(wp, this.o), this.n);
          minU = Math.min(minU, du); maxU = Math.max(maxU, du);
          minV = Math.min(minV, dv); maxV = Math.max(maxV, dv);
          minN = Math.min(minN, dn); maxN = Math.max(maxN, dn);
        }
    const cx = (mm: number) => (this.w - 1) / 2 + mm / this.px;
    const cy = (mm: number) => (this.h - 1) / 2 - mm / this.px;
    return {
      x0: cx(minU),
      x1: cx(maxU),
      y0: cy(maxV), // maxV (up) -> smaller canvas y
      y1: cy(minV),
      inside: minN <= 0 && 0 <= maxN,
    };
  }

  private drawCropDim(g: CanvasRenderingContext2D): void {
    const img = this.top!;
    const p = this.projectBox(img.cropBoxOrFull());
    this.cropRedPx = [p.x0, p.x1, p.y0, p.y1];
    g.fillStyle = `rgba(0,0,0,${Math.min(img.cropDim, 0.95)})`;
    if (!p.inside) {
      g.fillRect(0, 0, this.w, this.h);
    } else {
      g.beginPath();
      g.rect(0, 0, this.w, this.h);
      g.rect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0);
      g.fill('evenodd');
    }
  }

  private drawCropBox(g: CanvasRenderingContext2D): void {
    const img = this.top!;
    const r = this.cropRedPx;
    if (!r) return;
    const [x0, x1, y0, y1] = r;
    g.strokeStyle = RED;
    g.lineWidth = 2;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // yellow handle squares at corners + edge midpoints
    g.fillStyle = '#e8e84a';
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    for (const [hx, hy] of [
      [x0, y0], [mx, y0], [x1, y0],
      [x0, my], [x1, my],
      [x0, y1], [mx, y1], [x1, y1],
    ])
      g.fillRect(hx - 3, hy - 3, 6, 6);
    // top-right read-out (desktop crop panel): crop box, fg window, image range
    const box = img.cropBoxOrFull().map((v) => Math.round(v));
    const [lo, hi] = img.fgWindow;
    const rx = this.w - 4;
    let ry = 24; // below the maximize button
    this.halo(g, `(${box.join(', ')})`, rx, ry, 'right', 'top', 12);
    ry += 16;
    this.halo(g, `fg: ${lo.toFixed(0)} .. ${hi.toFixed(0)}`, rx, ry, 'right', 'top', 12);
    ry += 16;
    this.halo(g, `img: ${img.valueMin.toFixed(0)} .. ${img.valueMax.toFixed(0)}`, rx, ry, 'right', 'top', 12);
  }

  private drawRegistration(g: CanvasRenderingContext2D): void {
    const pivot = this.bottom!.rotCenter;
    if (pivot) {
      const [x, y] = this.toCanvas(pivot);
      g.strokeStyle = '#e8e84a';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x - 8, y);
      g.lineTo(x + 8, y);
      g.moveTo(x, y - 8);
      g.lineTo(x, y + 8);
      g.stroke();
      g.beginPath();
      g.arc(x, y, 12, 0, 2 * Math.PI);
      g.stroke();
    }
    if (this.reg) {
      const r = this.reg;
      const txt =
        r.mode === 'translate'
          ? `shift: ${r.shift.toFixed(1)} mm`
          : r.mode === 'rotate'
            ? `angle: ${((r.angle * 180) / Math.PI).toFixed(1)}°`
            : `scale: ×${r.scale.toFixed(3)}`;
      this.halo(g, txt, this.w - HOT - 4, 4, 'right', 'top', 13);
    }
  }

  private halo(
    g: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
    fontPx = 14,
    bold = false,
  ): void {
    g.font = `${bold ? '600 ' : ''}${fontPx}px system-ui, sans-serif`;
    g.textAlign = align;
    g.textBaseline = baseline;
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, fontPx * 0.22);
    g.strokeStyle = 'rgba(0,0,0,0.9)';
    g.strokeText(text, x, y);
    g.fillStyle = '#fff';
    g.fillText(text, x, y);
  }

  private drawHotZones(g: CanvasRenderingContext2D): void {
    g.strokeStyle = ZONE;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(HOT + 0.5, 0);
    g.lineTo(HOT + 0.5, this.h);
    g.moveTo(this.w - HOT + 0.5, 0);
    g.lineTo(this.w - HOT + 0.5, this.h);
    g.moveTo(HOT, this.h - HOT + 0.5);
    g.lineTo(this.w - HOT, this.h - HOT + 0.5);
    g.stroke();
  }

  private drawColorBar(g: CanvasRenderingContext2D): void {
    const x0 = HOT;
    const x1 = this.w - HOT;
    const yTop = this.h - 14;
    if (x1 - x0 < 4) return;
    if (this.bottom) {
      // split bar: left width proportional to the blend factor (top weight)
      const xMid = x0 + this.vs.blendAlpha * (x1 - x0);
      this.gradientBar(g, x0, xMid, yTop, this.top!.colormap);
      this.gradientBar(g, xMid, x1, yTop, this.bottom.colormap);
    } else {
      this.gradientBar(g, x0, x1, yTop, this.top!.colormap);
    }
  }

  private gradientBar(
    g: CanvasRenderingContext2D,
    x0: number,
    x1: number,
    yTop: number,
    cm: number[][] | null,
  ): void {
    if (x1 - x0 < 1) return;
    const grad = g.createLinearGradient(x0, 0, x1, 0);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      if (cm) {
        const e = cm[Math.round(t * 255)];
        grad.addColorStop(t, `rgb(${e[0]},${e[1]},${e[2]})`);
      } else {
        const val = Math.round(t * 255);
        grad.addColorStop(t, `rgb(${val},${val},${val})`);
      }
    }
    g.fillStyle = grad;
    g.fillRect(x0, yTop, x1 - x0, 10);
  }

  private drawCrosshair(g: CanvasRenderingContext2D): void {
    const [cx, cy] = this.toCanvas(this.vs.crosshair as Vec3);
    g.strokeStyle = RED;
    g.lineWidth = 1;
    if (this.crosshairStyle === 'dashed') {
      g.setLineDash([6, 6]);
      g.beginPath();
      g.moveTo(0, cy);
      g.lineTo(this.w, cy);
      g.moveTo(cx, 0);
      g.lineTo(cx, this.h);
      g.stroke();
      g.setLineDash([]);
    } else {
      g.beginPath();
      g.moveTo(cx - CROSS_ARM, cy);
      g.lineTo(cx + CROSS_ARM, cy);
      g.moveTo(cx, cy - CROSS_ARM);
      g.lineTo(cx, cy + CROSS_ARM);
      g.stroke();
    }
  }

  private drawLetters(g: CanvasRenderingContext2D): void {
    const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
    this.halo(g, axisLetter(this.v), this.w / 2, 3, 'center', 'top', 15);
    this.halo(g, axisLetter(neg(this.v)), this.w / 2, this.h - HOT - 3, 'center', 'bottom', 15);
    this.halo(g, axisLetter(neg(this.u)), 4, this.h / 2, 'left', 'middle', 15);
    this.halo(g, axisLetter(this.u), this.w - 4, this.h / 2, 'right', 'middle', 15);
  }

  private drawScaleBar(g: CanvasRenderingContext2D): void {
    const target = 0.18 * this.w * this.px;
    const mm = NICE_MM.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    const barPx = mm / this.px;
    const x1 = this.w - HOT - 4;
    const x0 = x1 - barPx;
    const y = this.h - HOT - 8;
    g.strokeStyle = '#000';
    g.lineWidth = 4;
    this.scaleTicks(g, x0, x1, y);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    this.scaleTicks(g, x0, x1, y);
    this.halo(g, `${mm} mm`, x1, y - 6, 'right', 'bottom', 12);
  }

  private scaleTicks(g: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.moveTo(x0, y - 4);
    g.lineTo(x0, y + 4);
    g.moveTo(x1, y - 4);
    g.lineTo(x1, y + 4);
    g.stroke();
  }

  private drawViewName(g: CanvasRenderingContext2D): void {
    this.halo(g, this.view[0].toUpperCase() + this.view.slice(1), 6, 4, 'left', 'top', 13, true);
  }

  private drawCornerButtons(g: CanvasRenderingContext2D): void {
    const s = 16;
    const m = 4;
    const gap = 3;
    const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
    const btn = (rect: Rect, glyph: string, act: () => void) => {
      g.strokeStyle = '#e8e84a';
      g.lineWidth = 1;
      g.strokeRect(rect.x0 + 0.5, rect.y0 + 0.5, s, s);
      this.halo(g, glyph, (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2 + 0.5, 'center', 'middle', 12);
      this.buttons.push({ rect, act });
    };
    const mk = (x0: number, y0: number): Rect => ({ x0, y0, x1: x0 + s, y1: y0 + s });
    btn(mk(m, this.h - m - 2 * s - gap), '+', () => this.zoomStep(1));
    btn(mk(m, this.h - m - s), '−', () => this.zoomStep(-1));
    btn(mk(this.w - m - s, this.h - m - 2 * s - gap), axisLetter(this.n), () => this.scroll(1));
    btn(mk(this.w - m - s, this.h - m - s), axisLetter(neg(this.n)), () => this.scroll(-1));
    const mr = mk(this.w - m - s, m);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    this.drawMaximizeGlyph(g, mr);
    this.buttons.push({ rect: mr, act: () => this.onMaximize?.() });
  }

  private drawMaximizeGlyph(g: CanvasRenderingContext2D, r: Rect): void {
    const a = 4;
    const pts = [
      [r.x0, r.y0 + a, r.x0, r.y0, r.x0 + a, r.y0],
      [r.x1 - a, r.y0, r.x1, r.y0, r.x1, r.y0 + a],
      [r.x1, r.y1 - a, r.x1, r.y1, r.x1 - a, r.y1],
      [r.x0 + a, r.y1, r.x0, r.y1, r.x0, r.y1 - a],
    ];
    g.beginPath();
    for (const [ax, ay, bx, by, cx, cy] of pts) {
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.lineTo(cx, cy);
    }
    g.stroke();
  }

  // --- interaction (CSS px, y-up) -------------------------------------------
  private xy(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.container.getBoundingClientRect();
    return [e.clientX - r.left, this.h - 1 - (e.clientY - r.top)];
  }

  private hitButton(vx: number, vy: number): (() => void) | null {
    const cy = this.h - 1 - vy;
    for (const b of this.buttons) {
      if (vx >= b.rect.x0 && vx <= b.rect.x1 && cy >= b.rect.y0 && cy <= b.rect.y1) return b.act;
    }
    return null;
  }

  private toWorld(vx: number, vy: number): Vec3 {
    const du = (vx - (this.w - 1) / 2) * this.px;
    const dv = (vy - (this.h - 1) / 2) * this.px;
    return vadd(this.o, vadd(vscale(this.u, du), vscale(this.v, dv)));
  }

  private setCrosshairFromMouse(vx: number, vy: number): void {
    this.vs.crosshair = this.toWorld(vx, vy);
    this.onCrosshair?.();
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.top) return;
    const [vx, vy] = this.xy(e);
    const now = performance.now();
    const isDouble =
      e.button === this.lastPress.button &&
      now - this.lastPress.t < DBL_MS &&
      Math.abs(vx - this.lastPress.x) < DBL_PX &&
      Math.abs(vy - this.lastPress.y) < DBL_PX;
    this.lastPress = { t: now, x: vx, y: vy, button: e.button };
    this.last = [vx, vy];
    e.preventDefault();

    if (e.button === 0) {
      const act = this.hitButton(vx, vy);
      if (act) {
        act();
        return;
      }
    }
    this.container.setPointerCapture?.(e.pointerId);
    const inSides = vx > HOT && vx < this.w - HOT;

    const registering = this.tool === 'register' && this.bottom !== null;
    const cropping = this.tool === 'crop';

    if (e.button === 0) {
      if (isDouble) {
        if (vx <= HOT) this.vs.zoom = 1.0;
        else if (vx >= this.w - HOT) this.resetSliceCentre();
        else if (vy <= HOT && inSides) this.vs.blendAlpha = 0.5;
        else if (cropping) this.top.fgWindow[0] = this.top.valueMin; // reset fg lower
        else if (this.tool === 'measure') this.clearMeasures();
        else if (registering) this.regSetPivot(vx, vy);
        else this.onRecenterAll?.();
        this.onChanged?.();
        return;
      }
      if (vx <= HOT) this.mode = 'zoom';
      else if (vx >= this.w - HOT) this.mode = 'slice';
      else if (vy <= HOT && inSides && this.bottom) this.mode = 'blend';
      else if (cropping) {
        const hit = this.cropHit(vx, vy);
        if (hit) {
          this.cropResize = hit;
          this.mode = 'crop';
        } else {
          this.mode = 'fg_lo'; // body drag -> fg lower bound
          this.onFgPreview?.(true);
        }
      } else if (this.tool === 'measure') this.measureLeftClick(vx, vy, e.ctrlKey);
      else if (this.tool === 'overlay' && this.bottom) {
        this.overlayMode = 'checker';
        this.overlayCenter = [vx, vy];
        this.mode = 'overlay';
        this.onChanged?.();
      } else if (registering) this.regStart('translate', vx, vy);
      else {
        this.mode = 'cross';
        this.setCrosshairFromMouse(vx, vy);
      }
    } else if (e.button === 1) {
      if (isDouble) {
        this.center = [0, 0, 0];
        this.onChanged?.();
      } else if (registering && this.regScaling) this.regStart('scale', vx, vy);
      else this.mode = 'pan';
    } else if (e.button === 2) {
      if (vy <= HOT && inSides && this.bottom) {
        this.vs.blendAlpha = this.vs.blendAlpha >= 0.5 ? 0.0 : 1.0; // right on blend zone: toggle
        this.onChanged?.();
      } else if (cropping) {
        if (isDouble) this.top.fgWindow[1] = this.top.valueMax; // reset fg upper
        else {
          this.mode = 'fg_hi';
          this.onFgPreview?.(true);
        }
        this.onChanged?.();
      } else if (this.tool === 'measure') this.measureRightClick(vx, vy);
      else if (this.tool === 'overlay' && this.bottom) {
        this.overlayMode = 'patch';
        this.overlayCenter = [vx, vy];
        this.mode = 'overlay';
        this.onChanged?.();
      } else if (registering) this.regStart('rotate', vx, vy);
      else if (isDouble) {
        [this.top.level, this.top.window] = [this.top.autoLevel, this.top.autoWindow];
        this.onChanged?.();
      } else this.mode = 'wl';
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.top) return;
    const [vx, vy] = this.xy(e);
    if (this.mode === null) {
      // measure: the pending point follows the mouse between clicks (no button held)
      if (this.tool === 'measure' && this.measureActive) this.measureTrack(vx, vy);
      return;
    }
    const [lx, ly] = this.last;

    if (this.mode === 'cross') {
      this.setCrosshairFromMouse(vx, vy);
      this.last = [vx, vy];
    } else if (this.mode === 'pan') {
      this.center = vsub(
        this.center,
        vadd(vscale(this.u, (vx - lx) * this.px), vscale(this.v, (vy - ly) * this.px)),
      );
      this.last = [vx, vy];
      this.onChanged?.();
    } else if (this.mode === 'zoom') {
      const z = this.vs.zoom * Math.pow(1.005, vy - ly);
      this.vs.zoom = Math.min(Math.max(z, 0.1), 50.0);
      this.last = [vx, vy];
      this.onChanged?.();
    } else if (this.mode === 'wl') {
      const rate = Math.max(this.top.window, 1.0) * 0.005;
      this.top.window = Math.max(this.top.window - (vx - lx) * rate, 1.0);
      this.top.level = this.top.level - (vy - ly) * rate;
      this.last = [vx, vy];
      this.onChanged?.();
    } else if (this.mode === 'blend') {
      this.vs.blendAlpha = Math.min(Math.max(this.vs.blendAlpha + (vx - lx) / this.w, 0), 1);
      this.last = [vx, vy];
      this.onChanged?.();
    } else if (this.mode === 'slice') {
      const steps = Math.trunc((vy - ly) / SLICE_DRAG_PX);
      if (steps) {
        this.last = [vx, ly + steps * SLICE_DRAG_PX];
        this.scroll(steps);
      }
    } else if (this.mode === 'reg') {
      this.regDrag(vx, vy);
    } else if (this.mode === 'fg_lo' || this.mode === 'fg_hi') {
      this.fgDrag(this.mode === 'fg_lo' ? 'lo' : 'hi', vy - ly);
      this.last = [vx, vy];
    } else if (this.mode === 'crop') {
      this.cropResizeApply(vx, vy);
    } else if (this.mode === 'overlay') {
      this.overlayCenter = [vx, vy];
      this.onChanged?.();
    }
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.mode !== null) this.container.releasePointerCapture?.(e.pointerId);
    if (this.mode === 'reg' && this.reg) {
      this.reg.img.regDropCurrentIfIdentity(); // a click with no drag -> no step
      this.reg = null;
      this.onRegChange?.();
    }
    if (this.mode === 'overlay') {
      this.overlayMode = null; // release reverts the checker/patch to the plain view
      this.onChanged?.();
    }
    if (this.mode === 'fg_lo' || this.mode === 'fg_hi') this.onFgPreview?.(false); // clear red
    this.cropResize = null;
    this.mode = null;
  };

  // --- crop tool (foreground window + crop box) -----------------------------
  private fgDrag(which: 'lo' | 'hi', dyPx: number): void {
    const img = this.top!;
    // Scale to the W/L window (responsive) rather than the full range: CT value_max can be
    // huge (metal/artifact), which would make a full-range rate barely move.
    const rate = Math.max(img.window, 1.0) * 0.01; // value per px
    let [lo, hi] = img.fgWindow;
    if (which === 'lo') lo = Math.min(Math.max(lo + dyPx * rate, img.valueMin), hi);
    else hi = Math.max(Math.min(hi + dyPx * rate, img.valueMax), lo);
    img.fgWindow = [lo, hi];
    this.onChanged?.();
  }

  /** Which crop-box handle is under the cursor: a set of edges, or null (body). */
  private cropHit(vx: number, vy: number): Set<string> | null {
    if (!this.cropRedPx) return null;
    const [x0, x1, cy0, cy1] = this.cropRedPx;
    const cy = this.h - 1 - vy; // box rect stored in canvas y-down
    const tol = 6;
    const y0 = Math.min(cy0, cy1);
    const y1 = Math.max(cy0, cy1);
    const edges = new Set<string>();
    if (Math.abs(vx - x0) <= tol && y0 - tol <= cy && cy <= y1 + tol) edges.add('left');
    if (Math.abs(vx - x1) <= tol && y0 - tol <= cy && cy <= y1 + tol) edges.add('right');
    if (Math.abs(cy - y0) <= tol && x0 - tol <= vx && vx <= x1 + tol) edges.add('top');
    if (Math.abs(cy - y1) <= tol && x0 - tol <= vx && vx <= x1 + tol) edges.add('bottom');
    return edges.size ? edges : null;
  }

  /** Resize the crop box: map the cursor to a voxel index and set the dragged bound(s). */
  private cropResizeApply(vx: number, vy: number): void {
    const img = this.top!;
    if (!this.cropResize) return;
    const ijk = img.worldToPixel(this.toWorld(vx, vy));
    const size = img.size;
    // which voxel axis each screen axis maps to (project onto the image direction cols)
    const axisOf = (wv: Vec3): [number, number] => {
      const d = img.direction; // row-major 3x3; proj = d^T @ wv
      const proj = [
        d[0] * wv[0] + d[3] * wv[1] + d[6] * wv[2],
        d[1] * wv[0] + d[4] * wv[1] + d[7] * wv[2],
        d[2] * wv[0] + d[5] * wv[1] + d[8] * wv[2],
      ];
      let k = 0;
      if (Math.abs(proj[1]) > Math.abs(proj[k])) k = 1;
      if (Math.abs(proj[2]) > Math.abs(proj[k])) k = 2;
      return [k, proj[k] >= 0 ? 1 : -1];
    };
    const [axU, sgnU] = axisOf(this.u);
    const [axV, sgnV] = axisOf(this.v);
    const edgeBound = (edge: string): [number, number] => {
      if (edge === 'left') return [axU, sgnU > 0 ? 0 : 1];
      if (edge === 'right') return [axU, sgnU > 0 ? 1 : 0];
      if (edge === 'bottom') return [axV, sgnV > 0 ? 0 : 1];
      return [axV, sgnV > 0 ? 1 : 0]; // top
    };
    const box = img.cropBoxOrFull();
    for (const edge of this.cropResize) {
      const [ax, which] = edgeBound(edge);
      const vi = Math.max(0, Math.min(size[ax] - 1, Math.round(ijk[ax])));
      if (which === 0) box[ax * 2] = Math.min(vi, box[ax * 2 + 1]);
      else box[ax * 2 + 1] = Math.max(vi, box[ax * 2]);
    }
    img.cropBox = box;
    this.onChanged?.();
  }

  // --- measure tool (world-space; ports reslice_view _measure_*) -------------
  private clearMeasures(): void {
    this.measures = [];
    this.measureActive = null;
  }

  /** Two left clicks -> a distance (Ctrl = snap to 45°). */
  private measureLeftClick(vx: number, vy: number, ctrl: boolean): void {
    const wp = this.toWorld(vx, vy);
    const a = this.measureActive;
    if (a && (a.mode === 'free' || a.mode === 'ortho')) {
      a.p1 = wp;
      if (a.p0[0] === wp[0] && a.p0[1] === wp[1] && a.p0[2] === wp[2]) this.measureActive = null;
      else {
        a.phase = 'done';
        this.measures.push(a);
        this.measureActive = null;
      }
    } else {
      this.measureActive = { mode: ctrl ? 'ortho' : 'free', p0: wp, p1: wp, pta: null, phase: 'p1' };
    }
    this.onChanged?.();
  }

  /** Three right clicks -> an angle: 1st arm end, 2nd vertex, 3rd other arm end. */
  private measureRightClick(vx: number, vy: number): void {
    const wp = this.toWorld(vx, vy);
    const a = this.measureActive;
    if (a && a.mode === 'angle') {
      if (a.phase === 'vertex') {
        a.p0 = wp;
        a.p1 = wp;
        a.phase = 'arm2';
      } else {
        a.p1 = wp;
        a.phase = 'done';
        this.measures.push(a);
        this.measureActive = null;
      }
    } else {
      this.measureActive = { mode: 'angle', p0: wp, p1: wp, pta: wp, phase: 'vertex' };
    }
    this.onChanged?.();
  }

  private measureTrack(vx: number, vy: number): void {
    const a = this.measureActive!;
    const wp = this.toWorld(vx, vy);
    if (a.phase === 'vertex') {
      a.p0 = wp;
      a.p1 = wp;
    } else {
      a.p1 = wp;
    }
    this.onChanged?.();
  }

  /** Drop measurements when the slice/orientation changes (they belong to one plane). */
  private syncMeasures(): void {
    if (this.tool !== 'measure') {
      if (this.measures.length || this.measureActive) this.clearMeasures();
      this.measPlane = null;
      return;
    }
    const off = Math.round(vdot(this.vs.crosshair as Vec3, this.n) * 1e4) / 1e4;
    const plane = `${this.vs.radiological}:${off}`;
    if (plane !== this.measPlane) {
      this.measures = [];
      this.measureActive = null;
      this.measPlane = plane;
    }
  }

  private drawMeasures(g: CanvasRenderingContext2D): void {
    const items = this.measureActive ? [...this.measures, this.measureActive] : this.measures;
    for (const m of items) {
      g.strokeStyle = '#4dff66'; // re-set each item: halo() below mutates strokeStyle
      g.lineWidth = 1;
      let [x0, y0] = this.toCanvas(m.p0);
      let [x1, y1] = this.toCanvas(m.p1);
      if (m.mode === 'angle') {
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        if (m.pta) {
          const [xa, ya] = this.toCanvas(m.pta);
          g.moveTo(x0, y0);
          g.lineTo(xa, ya);
        }
        g.stroke();
        if (m.pta) {
          const a: Vec3 = vsub(m.pta, m.p0);
          const b: Vec3 = vsub(m.p1, m.p0);
          const na = Math.hypot(a[0], a[1], a[2]);
          const nb = Math.hypot(b[0], b[1], b[2]);
          if (na > 1e-6 && nb > 1e-6) {
            const deg = (Math.acos(Math.min(1, Math.max(-1, vdot(a, b) / (na * nb)))) * 180) / Math.PI;
            this.halo(g, `${deg.toFixed(1)}°`, x0 + 10, y0 - 6, 'left', 'bottom', 12);
          }
        }
        continue;
      }
      if (m.mode === 'ortho') {
        // snap the screen direction to the nearest 45°, keeping the length
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        x1 = x0 + len * Math.cos(ang);
        y1 = y0 + len * Math.sin(ang);
      }
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      // perpendicular end ticks
      const vX = x1 - x0;
      const vY = y1 - y0;
      const ln = Math.hypot(vX, vY);
      if (ln > 1e-6) {
        const ux = (-vY / ln) * 5;
        const uy = (vX / ln) * 5;
        g.moveTo(x0 - ux, y0 - uy);
        g.lineTo(x0 + ux, y0 + uy);
        g.moveTo(x1 - ux, y1 - uy);
        g.lineTo(x1 + ux, y1 + uy);
      }
      g.stroke();
      const mm = Math.hypot(m.p1[0] - m.p0[0], m.p1[1] - m.p0[1], m.p1[2] - m.p0[2]);
      this.halo(g, `${mm.toFixed(1)} mm`, (x0 + x1) / 2 + 6, (y0 + y1) / 2 + 6, 'left', 'top', 12);
    }
  }

  // --- manual registration (moves the bottom image; desktop reslice_view _reg_*) ---------
  setTool(tool: Tool2D): void {
    this.tool = tool;
    if (tool !== 'overlay') this.overlayMode = null; // revert to the GPU blend
    this.update();
  }

  /** Result-display structures: hand them to the active overlay method, which builds whatever it
   *  needs (per-mesh cutters, masks, ...) and draws the cross-section overlay each frame. */
  setStructures(structures: Structure[]): void {
    this.structures = structures;
    this.overlayMethod.setStructures(structures);
    this.update();
  }

  /** Preop-plan line overlays projected onto this slice: the trajectory display lines and the
   *  scala-tympani A/B measures. Port of reslice_view._update_trajectories — the desktop draws
   *  the whole segment regardless of where it crosses the slice, so a trajectory approaching
   *  from outside the plane still reads. */
  setPlanSegments(segments: PlanSegment[]): void {
    this.planSegments = segments;
    this.update();
  }

  /** Electrode contacts for this slice, and whether Point projection is on — the desktop passes
   *  both together (reslice_view.set_markers), because the flag decides what the layer draws. */
  setMarkers(markers: Marker[], pointProjection: boolean): void {
    this.markers = markers;
    this.pointProjection = pointProjection;
    this.update();
  }

  /** Switch the 2D structure-overlay technique live (mesh-projection / contour / mask). */
  setOverlayMethod(id: OverlayMethodId): void {
    if (id === this.overlayMethodId) return;
    this.overlayMethodId = id;
    this.overlayMethod.delete();
    this.overlayMethod = createOverlay(id);
    this.overlayMethod.setFillAlpha?.(this.overlayFillAlpha);
    this.overlayMethod.setStructures(this.structures);
    this.update();
  }

  /** Pin the overlay fill opacity (the desktop's transparent/solid 2D-mesh modes); null keeps
   *  the method's own rule. */
  setOverlayFillAlpha(alpha: number | null): void {
    this.overlayFillAlpha = alpha;
    this.overlayMethod.setFillAlpha?.(alpha);
    this.update();
  }

  /** Read-only per-frame slice geometry the overlay method projects world points with. */
  private sliceView(): SliceView {
    return {
      u: this.u,
      v: this.v,
      n: this.n,
      o: this.o,
      w: this.w,
      h: this.h,
      px: this.px,
      toCanvas: (world) => this.toCanvas(world),
    };
  }

  private regStart(mode: RegCtx['mode'], vx: number, vy: number): void {
    const moving = this.bottom;
    if (!moving) return;
    const c = moving.rotCenter ?? ([...(this.vs.crosshair as Vec3)] as Vec3);
    moving.regPushRigid(null, mode === 'scale' ? 'scale' : 'rigid');
    this.reg = {
      img: moving,
      mode,
      x0: vx,
      y0: vy,
      u: this.u,
      v: this.v,
      o: this.o,
      px: this.px,
      c,
      axis: vcross(this.u, this.v),
      shift: 0,
      angle: 0,
      scale: 1,
    };
    this.mode = 'reg';
  }

  private regDrag(vx: number, vy: number): void {
    const r = this.reg;
    if (!r) return;
    let motion: Mat4;
    if (r.mode === 'translate') {
      const d = vadd(vscale(r.u, (vx - r.x0) * r.px), vscale(r.v, (vy - r.y0) * r.px));
      motion = translation(d);
      r.shift = r.px * Math.hypot(vx - r.x0, vy - r.y0);
    } else if (r.mode === 'scale') {
      const s = Math.exp((vy - r.y0) * 0.005); // drag up = enlarge
      r.scale = s;
      motion = mul(translation(r.c), diag([s, s, s, 1]), translation([-r.c[0], -r.c[1], -r.c[2]]));
    } else {
      const cu = vdot(vsub(r.c, r.o), r.u);
      const cv = vdot(vsub(r.c, r.o), r.v);
      const cx = cu / r.px + (this.w - 1) / 2;
      const cy = cv / r.px + (this.h - 1) / 2;
      const theta = Math.atan2(vy - cy, vx - cx) - Math.atan2(r.y0 - cy, r.x0 - cx);
      r.angle = theta;
      motion = rotation(r.axis, theta, r.c);
    }
    r.img.regSetCurrent(invert(motion));
    this.onChanged?.();
  }

  private regSetPivot(vx: number, vy: number): void {
    if (this.bottom) this.bottom.rotCenter = this.toWorld(vx, vy);
  }

  private onWheel = (e: WheelEvent) => {
    this.scroll(e.deltaY > 0 ? -1 : 1);
    e.preventDefault();
  };

  private zoomStep(dir: number): void {
    const z = this.vs.zoom;
    this.vs.zoom =
      dir > 0
        ? (ZOOM_LEVELS.find((lv) => lv > z + 1e-6) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1])
        : ([...ZOOM_LEVELS].reverse().find((lv) => lv < z - 1e-6) ?? ZOOM_LEVELS[0]);
    this.onChanged?.();
  }

  private scroll(steps: number): void {
    const [, , n] = viewAxes(this.view, this.vs.radiological, this.vs.orientation);
    const step = this.sliceByVoxel ? this.voxelStepAlong(n) : this.vs.sliceStep;
    this.vs.crosshair = vadd(this.vs.crosshair as Vec3, vscale(n, steps * step));
    this.onChanged?.();
  }

  /** Image voxel spacing along the axis most aligned with the view normal (= one slice). */
  private voxelStepAlong(n: Vec3): number {
    const img = this.top;
    if (!img) return this.vs.sliceStep;
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
    return img.spacing[best];
  }

  private resetSliceCentre(): void {
    const [, , n] = viewAxes(this.view, this.vs.radiological, this.vs.orientation);
    const c = this.vs.crosshair as Vec3;
    this.vs.crosshair = vsub(c, vscale(n, vdot(c, n)));
  }

  private preventCtx = (e: Event) => e.preventDefault();

  /** Capture this pane as a PNG data URL: the CT (WebGL) composited with the 2D overlay canvas
   *  (structure cross-sections + HUD), which live on a separate canvas. */
  async captureImage(): Promise<string> {
    const view = this.grw.getApiSpecificRenderWindow();
    const p = view.captureNextImage('image/png');
    this.grw.getRenderWindow().render();
    const ctUrl = (await p) ?? '';
    if (!ctUrl) return '';
    const base = new window.Image();
    await new Promise((res) => {
      base.onload = res;
      base.src = ctUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = base.width;
    cv.height = base.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(this.overlay, 0, 0, base.width, base.height); // structure fills + HUD
    return cv.toDataURL('image/png');
  }

  delete(): void {
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('contextmenu', this.preventCtx);
    this.overlayMethod.delete();
    this.grw.delete();
    this.container.replaceChildren();
  }
}
