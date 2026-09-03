// Port of pv_core/scene.py — Scene (images + top/bottom slots) and ViewState
// (crosshair, slice step, zoom, blend, fov, radiological) + view_axes.

import type { Image } from './image';
import { applyToVector, identity, invert, vadd, vscale, type Mat4, type Vec3 } from './mat4';

export const SLICE_STEPS = [0.1, 0.2, 0.5, 1.0, 2.0] as const; // mm; processing default 2.0

export type ViewName = 'axial' | 'sagittal' | 'coronal';

// Natural screen orientation per view (IDL IPgrView2D oriN): signed L/P/S axis codes
// for (x-right, y-up, slice-normal). +1/2/3 = L/P/S; negative = R/A/I.
const ORIN: Record<'true' | 'false', Record<ViewName, [number, number, number]>> = {
  true: {
    // radiological
    sagittal: [2, 3, -1], // P / S / R
    axial: [1, -2, 3], // L / A / S
    coronal: [1, 3, 2], // L / S / P
  },
  false: {
    // anatomical
    sagittal: [2, 3, -1],
    axial: [-1, -2, -3],
    coronal: [-1, 3, -2],
  },
};

function axisVector(code: number): Vec3 {
  const v: Vec3 = [0, 0, 0];
  v[Math.abs(code) - 1] = code > 0 ? 1 : -1;
  return v;
}

/** (u, v, n) = screen x-right, y-up, slice-normal in world L/P/S, rotated by the view's
 *  `orientation` (identity = the world axes; see ViewState.orientation). */
export function viewAxes(view: ViewName, radiological = true, orientation?: Mat4): [Vec3, Vec3, Vec3] {
  const codes = ORIN[radiological ? 'true' : 'false'][view];
  const axes: [Vec3, Vec3, Vec3] = [axisVector(codes[0]), axisVector(codes[1]), axisVector(codes[2])];
  if (!orientation) return axes;
  return axes.map((a) => applyToVector(orientation, a)) as [Vec3, Vec3, Vec3];
}

/** The desktop's 2D orientation "Primary": slice along the PRIMARY IMAGE's own grid planes rather
 *  than the world axes — this is what the desktop's postop view uses.
 *
 *  It is just the inverse of the image's placement rotation. Identity for a plain load or an
 *  unregistered plan, so those views are unchanged; it matters for a .cdb, whose preop/postop pair
 *  is re-framed onto the atlas (cdb_scene -> reorient.reframe_scene_to_atlas) — without it the
 *  world-axis slices cut the volume obliquely and the CT appears rotated in the panes. */
export function primaryOrientation(image: Image | null): Mat4 {
  if (!image) return identity();
  const inv = invert(image.worldMatrix);
  inv[3] = inv[7] = inv[11] = 0; // rotation only — the axes are directions, not points
  return inv;
}

export class ViewState {
  crosshair: Vec3 = [0, 0, 0]; // shared world point
  sliceStep = 2.0; // mm (processing panes; display panes scroll by voxel via ReslicePane.sliceByVoxel)
  zoom = 1.0; // shared by all 3 views
  blendAlpha = 0.5; // top*alpha + bottom*(1-alpha)
  fovMm = 256.0;
  radiological = true;
  /** World -> view rotation for the 2D panes (the desktop's "2D orientation"). Identity = the
   *  world axes ("Original"); primaryOrientation(top) = the primary image's grid planes
   *  ("Primary", the desktop's postop default). */
  orientation: Mat4 = identity();
}

export class Scene {
  images: Image[] = [];
  top: Image | null = null;
  bottom: Image | null = null;
  view = new ViewState();

  addImage(image: Image): Image {
    this.images.push(image);
    if (this.top === null) this.top = image;
    else if (image !== this.top) this.bottom = image;
    return image;
  }

  selectTop(image: Image): void {
    this.top = image;
    this.bottom = null;
  }

  selectBottom(image: Image): boolean {
    if (image === this.top) return false;
    this.bottom = image;
    return true;
  }

  removeImage(image: Image): void {
    const idx = this.images.indexOf(image);
    if (idx < 0) return;
    this.images.splice(idx, 1);
    const nxt =
      idx < this.images.length
        ? this.images[idx]
        : this.images.length
          ? this.images[this.images.length - 1]
          : null;
    if (this.top === image) this.top = nxt;
    if (this.bottom === image) this.bottom = nxt;
    if (this.bottom === this.top) this.bottom = null;
    if (this.top === null && this.images.length) {
      this.top = this.images[0];
      if (this.bottom === this.top) this.bottom = null;
    }
  }

  get blending(): boolean {
    return this.bottom !== null;
  }

  /** Move the crosshair along a view's normal by nSteps * sliceStep (mm). */
  scroll(view: ViewName, nSteps: number): void {
    const [, , n] = viewAxes(view, this.view.radiological, this.view.orientation);
    this.view.crosshair = vadd(this.view.crosshair, vscale(n, nSteps * this.view.sliceStep));
  }

  setCrosshair(world: Vec3): void {
    this.view.crosshair = [world[0], world[1], world[2]];
  }
}
