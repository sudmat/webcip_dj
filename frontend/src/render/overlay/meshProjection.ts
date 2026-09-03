// Mesh-projection overlay (the shipped method): fill each mesh's slice-plane cross-section on the
// 2D canvas. Closed loops are filled even-odd (handles concavity + nested loops/holes) in the
// structure's colour at 0.5; open patches (contacts) are stroked. See progress.md "2D overlay".

import type { Structure } from '../../core/structure';
import { SliceContours } from './sliceContours';
import {
  CONTACT_STROKE_PX,
  HIDE_IN_2D,
  OVERLAY_2D_COLOR,
  OVERLAY_2D_OPACITY,
  type OverlayMethod,
  type SliceView,
} from './types';

export class MeshProjectionOverlay implements OverlayMethod {
  private contours = new SliceContours();
  private structures: Structure[] = [];
  private fillAlpha: number | null = null; // set by the desktop's transparent/solid mesh modes

  setStructures(structures: Structure[]): void {
    this.structures = structures;
    this.contours.setStructures(structures);
  }

  setFillAlpha(alpha: number | null): void {
    this.fillAlpha = alpha;
  }

  draw(g: CanvasRenderingContext2D, view: SliceView): void {
    for (const s of this.structures) {
      if (!s.visible2d || HIDE_IN_2D.has(s.typeId)) continue;
      const cut = this.contours.cutFor(s.id, view);
      if (!cut || !cut.polylines.length) continue;
      const override = OVERLAY_2D_COLOR[s.typeId];
      const [r, gg, b] = override ?? s.color;
      const rgb = `${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)}`;
      if (cut.open) {
        // open patches (contacts): stroke the cut segments as thick marks
        g.strokeStyle = `rgba(${rgb},1)`;
        g.lineWidth = CONTACT_STROKE_PX;
        g.lineCap = 'round';
        g.beginPath();
        for (const seg of cut.polylines) {
          const [x0, y0] = view.toCanvas([seg[0], seg[1], seg[2]]);
          const [x1, y1] = view.toCanvas([seg[3], seg[4], seg[5]]);
          g.moveTo(x0, y0);
          g.lineTo(x1, y1);
        }
        g.stroke();
        continue;
      }
      g.beginPath();
      for (const loop of cut.polylines) {
        for (let i = 0; i < loop.length; i += 3) {
          const [cx, cy] = view.toCanvas([loop[i], loop[i + 1], loop[i + 2]]);
          if (i === 0) g.moveTo(cx, cy);
          else g.lineTo(cx, cy);
        }
        // A FILL closes every chain, open arcs included — the desktop does the same
        // (reslice_view._set_fill appends the start point before triangulating). Only the
        // contour/stroke pass leaves an open arc open.
        g.closePath();
      }
      // implants opaque, structures 0.5 — unless a mesh mode pinned the alpha
      g.fillStyle = `rgba(${rgb},${this.fillAlpha ?? (override ? 1 : OVERLAY_2D_OPACITY)})`;
      g.fill('evenodd');
    }
  }

  delete(): void {
    this.contours.delete();
  }
}
