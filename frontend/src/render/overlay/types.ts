// Pluggable 2D-overlay methods: how each structure/implant mesh is drawn as a cross-section mask
// on an MPR pane. ReslicePane owns one OverlayMethod at a time and can swap it live
// (setOverlayMethod), so a checkbox in the UI switches all panes between mesh-projection (filled
// planar cut), contour (outline), mask (voxel/raster), etc. without touching pane internals.

import type { Vec3 } from '../../core/mat4';
import type { Structure } from '../../core/structure';

/** Read-only per-frame slice geometry an overlay method needs to project world points onto the
 *  pane's 2D canvas. ReslicePane builds one each frame and passes it to draw(). */
export interface SliceView {
  readonly u: Vec3; // canvas +x axis in world
  readonly v: Vec3; // canvas +y (up) axis in world
  readonly n: Vec3; // slice-plane normal
  readonly o: Vec3; // world point on the slice plane (pane origin)
  readonly w: number; // pane width (CSS px)
  readonly h: number; // pane height (CSS px)
  readonly px: number; // world mm per CSS px
  toCanvas(world: Vec3): [number, number];
}

/** One way to render the structure cross-section overlay. Implementations own their own resources
 *  (cutters, caches, GPU layers) and are created/destroyed by ReslicePane on method switch. */
export interface OverlayMethod {
  /** (Re)bind the structures to display; called on load and whenever the set changes. */
  setStructures(structures: Structure[]): void;
  /** Draw the overlay for the current frame onto the pane's 2D canvas (under the HUD). */
  draw(g: CanvasRenderingContext2D, view: SliceView): void;
  /** Override the fill opacity (the desktop's "transparent" vs "solid" 2D-mesh modes);
   *  null restores the method's own rule. Only fill-based methods need this. */
  setFillAlpha?(alpha: number | null): void;
  /** Release any held resources. */
  delete(): void;
}

// 'mask' = the filled planar cross-section (mesh cut + even-odd fill); 'contour' = its outline.
export type OverlayMethodId = 'mask' | 'contour';

/** Methods offered in the UI switch, in display order. */
export const OVERLAY_METHODS: { id: OverlayMethodId; label: string }[] = [
  { id: 'mask', label: 'Mask' },
  { id: 'contour', label: 'Contour' },
];

// --- shared appearance rules (v2 display) ---------------------------------------------------
// v2 excludes the Promontory (type 30) and Round-window (type 40) from the 2D overlay
// (sceneSet.js addStructures), and draws every structure clip at a fixed 0.5 opacity.
export const HIDE_IN_2D = new Set([30, 40]);
export const OVERLAY_2D_OPACITY = 0.5;
// 2D-only implant colours (v2 `panelCtrl.js::showImplant`): Carrier RED, Contacts BLACK, both
// opaque, in the 2D panes only. Keyed by type_id; structures keep their config colour.
export const OVERLAY_2D_COLOR: Record<number, [number, number, number]> = {
  12: [1, 0, 0], // Implant Lead / Carrier
  13: [0, 0, 0], // Implant Electrodes / Contacts
};
// Contacts (type 13) are OPEN patches: the cut is an open line, not a fillable loop — stroke it.
export const STROKE_IN_2D = new Set([13]);
export const CONTACT_STROKE_PX = 3;
