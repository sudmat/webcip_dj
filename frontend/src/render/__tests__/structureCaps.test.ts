import { describe, expect, it } from 'vitest';
import { contourLoops } from '../structureCaps';

// vtkCutter's output shape: points + a line-cell array [n, i0, i1, ...] per cell.
function cells(segs: [number, number][]): Uint32Array {
  const out: number[] = [];
  for (const [a, b] of segs) out.push(2, a, b);
  return Uint32Array.from(out);
}
const pts = (n: number) => Float32Array.from(Array.from({ length: n * 3 }, (_, i) => i));

describe('contourLoops', () => {
  // A closed manifold (cochlea, ossicles) cuts to closed loops.
  it('chains a closed loop and reports it closed', () => {
    const r = contourLoops(pts(4), cells([[0, 1], [1, 2], [2, 3], [3, 0]]));
    expect(r).toHaveLength(1);
    expect(r[0].closed).toBe(true);
    expect(r[0].points).toHaveLength(4 * 3);
  });

  // An open surface (the External Auditory Canal is a tube open at both ends) cuts to an ARC.
  // Closing it would draw a lens instead of a curve — the bug this guards.
  it('leaves an open arc open', () => {
    const r = contourLoops(pts(4), cells([[0, 1], [1, 2], [2, 3]]));
    expect(r).toHaveLength(1);
    expect(r[0].closed).toBe(false);
    expect(r[0].points).toHaveLength(4 * 3);
  });

  // Walking must start at an ENDPOINT: from a middle vertex the chain would stop at one end and
  // the remainder would come back as a second, separate polyline.
  it('emits an arc as ONE polyline regardless of segment order', () => {
    const r = contourLoops(pts(5), cells([[2, 3], [0, 1], [3, 4], [1, 2]]));
    expect(r).toHaveLength(1);
    expect(r[0].closed).toBe(false);
    expect(r[0].points).toHaveLength(5 * 3);
  });

  // The EAC's real shape: two independent arcs from one cut.
  it('keeps several arcs separate', () => {
    const r = contourLoops(pts(6), cells([[0, 1], [1, 2], [3, 4], [4, 5]]));
    expect(r).toHaveLength(2);
    expect(r.every((c) => !c.closed)).toBe(true);
  });

  it('handles a closed loop and an open arc in the same cut', () => {
    const r = contourLoops(pts(7), cells([[0, 1], [1, 2], [2, 0], [3, 4], [4, 5]]));
    expect(r).toHaveLength(2);
    expect(r.filter((c) => c.closed)).toHaveLength(1);
    expect(r.filter((c) => !c.closed)).toHaveLength(1);
  });

  it('drops a degenerate single-point chain', () => {
    expect(contourLoops(pts(2), new Uint32Array([]))).toEqual([]);
  });
});
