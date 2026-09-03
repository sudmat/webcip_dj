// Contour overlay: the same slice-plane cut as the mesh method, but each loop is stroked (not
// filled), giving a clean vector outline of every structure cross-section over the CT.

import type { Structure } from '../../core/structure';
import { SliceContours } from './sliceContours';
import { CONTACT_STROKE_PX, HIDE_IN_2D, OVERLAY_2D_COLOR, type OverlayMethod, type SliceView } from './types';

const CONTOUR_PX = 2;

export class ContourOverlay implements OverlayMethod {
  private contours = new SliceContours();
  private structures: Structure[] = [];

  setStructures(structures: Structure[]): void {
    this.structures = structures;
    this.contours.setStructures(structures);
  }

  draw(g: CanvasRenderingContext2D, view: SliceView): void {
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const s of this.structures) {
      if (!s.visible2d || HIDE_IN_2D.has(s.typeId)) continue;
      const cut = this.contours.cutFor(s.id, view);
      if (!cut || !cut.polylines.length) continue;
      const [r, gg, b] = OVERLAY_2D_COLOR[s.typeId] ?? s.color;
      g.strokeStyle = `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`;
      g.lineWidth = cut.open ? CONTACT_STROKE_PX : CONTOUR_PX;
      g.beginPath();
      cut.polylines.forEach((line, k) => {
        if (cut.open) {
          const [x0, y0] = view.toCanvas([line[0], line[1], line[2]]);
          const [x1, y1] = view.toCanvas([line[3], line[4], line[5]]);
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
          return;
        }
        for (let i = 0; i < line.length; i += 3) {
          const [cx, cy] = view.toCanvas([line[i], line[i + 1], line[i + 2]]);
          if (i === 0) g.moveTo(cx, cy);
          else g.lineTo(cx, cy);
        }
        // Only join up a chain that actually closed. An open surface's section is an ARC — the
        // desktop strokes exactly what vtkStripper hands it (reslice_view._set_polylines), so
        // closing everything drew e.g. the External Auditory Canal as a lens instead of two curves.
        if (cut.closed[k]) g.closePath();
      });
      g.stroke();
    }
  }

  delete(): void {
    this.contours.delete();
  }
}
