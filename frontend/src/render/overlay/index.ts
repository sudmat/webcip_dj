// Overlay-method registry: create the OverlayMethod for a given id. Add a new 2D overlay method
// by implementing OverlayMethod, adding its id to OverlayMethodId + OVERLAY_METHODS (types.ts),
// and a case here — nothing in ReslicePane changes.

import { ContourOverlay } from './contourOverlay';
import { MeshProjectionOverlay } from './meshProjection';
import type { OverlayMethod, OverlayMethodId } from './types';

export type { OverlayMethod, OverlayMethodId, SliceView } from './types';
export { OVERLAY_METHODS } from './types';

export function createOverlay(id: OverlayMethodId): OverlayMethod {
  switch (id) {
    case 'contour':
      return new ContourOverlay();
    default:
      return new MeshProjectionOverlay(); // 'mask'
  }
}
