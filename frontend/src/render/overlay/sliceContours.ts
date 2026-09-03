// Shared slice-plane cut engine for the canvas overlay methods (mesh-projection fill + contour
// stroke). Each structure mesh gets a vtkCutter bound to a per-instance vtkPlane; cutting yields
// the exact intersection contour (a soup of 2-point segments), which structureCaps chains into
// closed loops (or leaves as open segments for un-closed patches). The cut is cached in world
// space and only recomputed when the slice plane moves — callers just re-project the cached
// geometry each frame, so pan/zoom stay cheap.

import vtkCutter from '@kitware/vtk.js/Filters/Core/Cutter';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import type { Structure } from '../../core/structure';
import { vdot } from '../../core/mat4';
import { meshToPolyData } from '../meshPoly';
import { contourLoops, contourSegments } from '../structureCaps';
import { HIDE_IN_2D, STROKE_IN_2D, type SliceView } from './types';

export interface CutResult {
  /** STROKE_IN_2D style (the v2 case implants' contacts): `polylines` are raw 2-point segments,
   *  drawn as thick marks. Nothing to do with whether a cut closed — see `closed`. */
  open: boolean;
  polylines: number[][]; // world-space: chained polylines [x0,y0,z0,...] or segment pairs
  /** Per polyline: did the chain close on itself? An OPEN arc must not be joined up — the
   *  External Auditory Canal is a tube open at both ends and cuts to two arcs. */
  closed: boolean[];
}

type Entry = {
  cutter: ReturnType<typeof vtkCutter.newInstance>;
  plane: ReturnType<typeof vtkPlane.newInstance>;
  typeId: number;
};

export class SliceContours {
  private cutters = new Map<string, Entry>();
  private cache = new Map<string, CutResult>();
  private key = ''; // slice the cache was cut at

  setStructures(structures: Structure[]): void {
    const ids = new Set(structures.map((s) => s.id));
    for (const id of [...this.cutters.keys()]) {
      if (!ids.has(id)) {
        this.cutters.delete(id);
        this.cache.delete(id);
      }
    }
    for (const s of structures) {
      if (HIDE_IN_2D.has(s.typeId)) continue; // Promontory / Round-window: 3D only, like v2
      if (!this.cutters.has(s.id)) {
        const plane = vtkPlane.newInstance();
        const cutter = vtkCutter.newInstance();
        cutter.setCutFunction(plane);
        cutter.setInputData(meshToPolyData(s.mesh));
        this.cutters.set(s.id, { cutter, plane, typeId: s.typeId });
      }
    }
    this.key = ''; // force a re-cut
  }

  /** Cached cut for one structure at the current slice; recuts all when the plane has moved. */
  cutFor(id: string, view: SliceView): CutResult | undefined {
    const key = `${view.n[0].toFixed(4)},${view.n[1].toFixed(4)},${view.n[2].toFixed(4)}:${vdot(view.o, view.n).toFixed(4)}`;
    if (key !== this.key) {
      this.key = key;
      this.cache.clear();
      for (const [sid, { cutter, plane, typeId }] of this.cutters) {
        plane.setNormal(view.n[0], view.n[1], view.n[2]);
        plane.setOrigin(view.o[0], view.o[1], view.o[2]);
        const out = cutter.getOutputData() as ReturnType<typeof meshToPolyData>;
        const pts = out.getPoints().getData() as Float32Array;
        const lines = out.getLines().getData() as Uint16Array | Uint32Array;
        const open = STROKE_IN_2D.has(typeId);
        const has = pts.length && lines.length;
        if (!has) {
          this.cache.set(sid, { open, polylines: [], closed: [] });
        } else if (open) {
          const segs = contourSegments(pts, lines);
          this.cache.set(sid, { open, polylines: segs, closed: segs.map(() => false) });
        } else {
          const cut = contourLoops(pts, lines);
          this.cache.set(sid, {
            open,
            polylines: cut.map((c) => c.points),
            closed: cut.map((c) => c.closed),
          });
        }
      }
    }
    return this.cache.get(id);
  }

  delete(): void {
    this.cutters.clear();
    this.cache.clear();
  }
}
