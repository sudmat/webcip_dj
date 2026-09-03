// Chain vtkCutter's unordered 2-point line segments into polylines so a slice-plane cross-section
// can be stroked (contour) or filled (mask) on the 2D overlay canvas.
//
// vtkCutter outputs the intersection of a mesh with the slice plane as a soup of line segments
// (getLines() = [2,a,b, 2,c,d, ...] into getPoints()). We build an adjacency map and walk each
// chain, marking edges used so each is emitted once. A closed manifold surface gives closed loops;
// an open one gives open arcs — see contourLoops. Points are flat world-space xyz; the caller
// projects them to canvas pixels (filling even-odd, which handles concavity and nested holes).

function edgeKey(a: number, b: number): number {
  return a < b ? a * 0x100000 + b : b * 0x100000 + a;
}

/** Raw cut segments as flat [x0,y0,z0,x1,y1,z1] world coords — one per 2-point line cell. Used for
 *  OPEN surfaces (e.g. the electrode contacts, which are un-closed patches) where the cut is an open
 *  line, not a fillable loop: the caller strokes these instead of filling. */
export function contourSegments(pts: Float32Array, lines: Uint16Array | Uint32Array): number[][] {
  const segs: number[][] = [];
  let i = 0;
  while (i < lines.length) {
    const k = lines[i++];
    for (let j = 0; j < k - 1; j++) {
      const a = lines[i + j];
      const b = lines[i + j + 1];
      segs.push([pts[a * 3], pts[a * 3 + 1], pts[a * 3 + 2], pts[b * 3], pts[b * 3 + 1], pts[b * 3 + 2]]);
    }
    i += k;
  }
  return segs;
}

/** One chained cross-section polyline: flat world xyz, and whether it closed on itself. */
export interface Contour {
  points: number[];
  closed: boolean;
}

/**
 * Chain vtkCutter's segment soup into polylines, reporting per polyline whether it is a CLOSED
 * loop or an OPEN arc — the desktop gets the same from `vtkStripper` with
 * `JoinContiguousSegmentsOn` (reslice_view._cut_polylines) and draws each as it comes.
 *
 * Openness is geometry, not a property of the structure: a closed manifold (cochlea, ossicles)
 * cuts to closed loops, while an open surface cuts to open arcs — the External Auditory Canal is
 * a tube open at both ends, so its section is two arcs that must NOT be joined up. Deciding this
 * per structure (a type-id list) silently closed those arcs into a lens shape.
 *
 * Endpoints are walked FIRST: starting an open arc from a middle vertex would walk to one end and
 * stop, splitting one arc into two halves.
 */
export function contourLoops(pts: Float32Array, lines: Uint16Array | Uint32Array): Contour[] {
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  let i = 0;
  while (i < lines.length) {
    const k = lines[i++];
    for (let j = 0; j < k - 1; j++) {
      const a = lines[i + j];
      const b = lines[i + j + 1];
      link(a, b);
      link(b, a);
    }
    i += k;
  }

  const used = new Set<number>();
  const out: Contour[] = [];

  const walk = (start: number) => {
    const points: number[] = [];
    let prev = -1;
    let cur = start;
    let closed = false;
    for (let guard = 0; guard < 1e6; guard++) {
      points.push(pts[cur * 3], pts[cur * 3 + 1], pts[cur * 3 + 2]);
      const nbrs = adj.get(cur)!;
      // prefer an unused edge that doesn't immediately backtrack
      let next = nbrs.find((n) => n !== prev && !used.has(edgeKey(cur, n)));
      if (next === undefined) next = nbrs.find((n) => !used.has(edgeKey(cur, n)));
      if (next === undefined) break;
      used.add(edgeKey(cur, next));
      prev = cur;
      cur = next;
      if (cur === start) {
        closed = true;
        break;
      }
    }
    if (points.length >= 6) out.push({ points, closed }); // >= 2 points to draw
  };

  const unusedAt = (v: number) => adj.get(v)!.some((n) => !used.has(edgeKey(v, n)));
  // open arcs first, from their endpoints (degree 1)
  for (const [v, nbrs] of adj) if (nbrs.length === 1 && unusedAt(v)) walk(v);
  // then whatever is left — closed loops
  for (const v of adj.keys()) if (unusedAt(v)) walk(v);
  return out;
}
