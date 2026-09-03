// Framing the views on an object — the arithmetic behind the desktop's auto-fits
// (validation_panel._activate_structures, four_up_viewer.center_on / focus_structure /
// _apply_3d_zoom). Pure: no vtk, no DOM, so it is unit-testable.
//
// The one invariant everything here rests on: a 2D pane shows `fovMm / zoom` mm of vertical
// field (ReslicePane's mm-per-pixel is (fovMm/zoom)/height), so "frame this object" means
// choosing a zoom that makes that field a little larger than the object.
import type { Vec3 } from './mat4';
import type { Structure } from './structure';

export interface Box {
  lo: Vec3;
  hi: Vec3;
}

/** How much larger than the object the visible field is made — validation_panel.py's `* 1.4`,
 *  i.e. the object fills 1/1.4 = 71% of the pane and the rest is margin. */
export const FIT_PAD = 1.4;

/** The world bounding box over every structure's mesh, or null if none has geometry.
 *
 *  Ports validation_panel.structures_world_bbox with one simplification: web meshes are baked
 *  to global world by the backend (backend/bake.py), so there is no per-structure
 *  inv(source_image.world_matrix) step. Like the desktop, HIDDEN structures still count — the
 *  box frames the segmentation, not the current checklist. */
export function structuresWorldBbox(structures: Structure[]): Box | null {
  let lo: Vec3 | null = null;
  let hi: Vec3 | null = null;
  for (const s of structures) {
    const p = s.mesh?.points;
    if (!p || !p.length) continue;
    if (lo === null || hi === null) {
      lo = [p[0], p[1], p[2]];
      hi = [p[0], p[1], p[2]];
    }
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
  }
  return lo === null || hi === null ? null : { lo, hi };
}

/** The box's midpoint — (lo + hi) / 2. Deliberately NOT a centroid: the desktop frames step 1
 *  on the box centre so nothing clips, while focus_structure centres a single mesh on its
 *  vertex mean (meshCentroid). */
export function boxCenter(b: Box): Vec3 {
  return [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
}

/** The LARGEST of the three side lengths — an isotropic worst case, so the box fits in every
 *  pane whichever way it is sliced. */
export function boxMaxExtent(b: Box): number {
  return Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]);
}

/** The 2D zoom that frames an object `extent` mm across (validation_panel.py:212).
 *
 *  Floored at 1.0 so a small field of view can't zoom the panes out past their default, and
 *  the 1e-3 guard keeps a degenerate (single-point) box from dividing by zero.
 *
 *  Note `fovMm` must be the LIVE value: a .cdb sets it to the crop's extent * 1.15
 *  (viewerController.loadCdb), not the 256 mm the desktop always has. */
export function fitZoom(fovMm: number, extent: number, pad = FIT_PAD): number {
  return Math.max(1, fovMm / Math.max(extent * pad, 1e-3));
}

/** The 3D camera's parallel scale that shows the same physical extent as a 2D pane at `zoom`
 *  (four_up_viewer._apply_3d_zoom).
 *
 *  VTK's parallel scale is the viewport HALF-height in world units, so 2*scale = fovMm/zoom
 *  makes the two match. Only meaningful in PARALLEL projection — in perspective the value is
 *  stored but has no visible effect. */
export function parallelScaleFor(fovMm: number, zoom: number): number {
  return Math.max(fovMm / zoom / 2, 1e-3);
}

/** `crosshair` with one component swept to a fraction `t` (0..1) along that axis of the box —
 *  validation_panel._on_axis_slider. The other two components are left alone, so a slider
 *  scrubs through the box in one direction without disturbing the other two panes' positions. */
export function boxAxisPoint(b: Box, axis: 0 | 1 | 2, crosshair: Vec3, t: number): Vec3 {
  const out: Vec3 = [crosshair[0], crosshair[1], crosshair[2]];
  out[axis] = b.lo[axis] + (b.hi[axis] - b.lo[axis]) * t;
  return out;
}

/** The mean of a packed n*3 point array, or null if empty (four_up_viewer.focus_structure's
 *  `verts.mean(axis=0)`). */
export function meshCentroid(points: Float32Array | null | undefined): Vec3 | null {
  if (!points || !points.length) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  const n = points.length / 3;
  for (let i = 0; i < points.length; i += 3) {
    x += points[i];
    y += points[i + 1];
    z += points[i + 2];
  }
  return [x / n, y / n, z / n];
}
