// Port of pv_core/geometry.py — coordinate-frame math (pure, no rendering).
// Frames: image-pixel (i,j,k) -> image-world (L/P/S mm, centred) -> global-world
// (world_matrix) -> LPS (origin at first pixel) -> RAS. See VIEWER_REBUILD.md §2.

import {
  diag,
  from3x3,
  identity,
  translation,
  type Mat4,
  type Vec3,
} from './mat4';

// LPS -> RAS : negate L and P.
export const LPS_TO_RAS: Mat4 = diag([-1, -1, 1, 1]);

/** Snap a row-major 3x3 direction-cosine matrix to the nearest signed-permutation.
 *  Greedy: each image axis (column, order i,j,k) claims the strongest L/P/S row not
 *  already taken (mirrors CIP GetDicomOrientation). Returns a row-major 9-array. */
export function nearestAxisAligned(direction: number[]): number[] {
  const d = (r: number, c: number) => direction[r * 3 + c];
  const p = new Array(9).fill(0);
  const used = new Set<number>();
  for (let c = 0; c < 3; c++) {
    // rows sorted by descending |d[row,c]|
    const rows = [0, 1, 2].sort((a, b) => Math.abs(d(b, c)) - Math.abs(d(a, c)));
    for (const r of rows) {
      if (!used.has(r)) {
        p[r * 3 + c] = d(r, c) >= 0 ? 1 : -1;
        used.add(r);
        break;
      }
    }
  }
  return p;
}

// per-LPS-axis anatomical letters: [negative dir, positive dir]
const AXIS_LETTERS: [string, string][] = [
  ['R', 'L'],
  ['A', 'P'],
  ['I', 'S'],
];

/** Signed L/P/S axis vector (+x/+y/+z = L/P/S) -> its anatomical letter. */
export function axisLetter(vec: Vec3): string {
  let i = 0;
  if (Math.abs(vec[1]) > Math.abs(vec[i])) i = 1;
  if (Math.abs(vec[2]) > Math.abs(vec[i])) i = 2;
  return AXIS_LETTERS[i][vec[i] > 0 ? 1 : 0];
}

/** 3-letter orientation code + signed axis numbers, e.g. "LPI (1 2 -3)". */
export function orientationLabel(direction: number[]): string {
  const p = nearestAxisAligned(direction);
  const col = (c: number): Vec3 => [p[c], p[3 + c], p[6 + c]];
  const letters: string[] = [];
  const numbers: string[] = [];
  for (let c = 0; c < 3; c++) {
    const cc = col(c);
    let i = 0;
    if (Math.abs(cc[1]) > Math.abs(cc[i])) i = 1;
    if (Math.abs(cc[2]) > Math.abs(cc[i])) i = 2;
    if (cc[i] === 0) return '';
    letters.push(axisLetter(cc));
    numbers.push(`${cc[i] > 0 ? '' : '-'}${i + 1}`);
  }
  return `${letters.join('')} (${numbers.join(' ')})`;
}

/** CIP orientation codes [±1,±2,±3] (1=L,2=P,3=S) -> row-major 3x3 direction matrix. */
export function directionFromOriCodes(codes: number[]): number[] {
  const m = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    const axis = Math.abs(codes[i]) - 1;
    m[axis * 3 + i] = codes[i] > 0 ? 1 : -1;
  }
  return m;
}

/** Voxel index -> image-world (centred, L/P/S mm): world = A @ (index - centre),
 *  A = direction @ diag(spacing). `direction` is a row-major 9-array (identity if null). */
export function pixelToImageWorld(
  spacing: Vec3,
  centerIndex: Vec3,
  direction: number[] | null,
): Mat4 {
  const d = direction ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // A = direction @ diag(spacing): scales each column of direction by spacing[col].
  const a = [
    d[0] * spacing[0], d[1] * spacing[1], d[2] * spacing[2],
    d[3] * spacing[0], d[4] * spacing[1], d[5] * spacing[2],
    d[6] * spacing[0], d[7] * spacing[1], d[8] * spacing[2],
  ];
  const m = from3x3(a);
  // translation = -A @ centre
  m[3] = -(a[0] * centerIndex[0] + a[1] * centerIndex[1] + a[2] * centerIndex[2]);
  m[7] = -(a[3] * centerIndex[0] + a[4] * centerIndex[1] + a[5] * centerIndex[2]);
  m[11] = -(a[6] * centerIndex[0] + a[7] * centerIndex[1] + a[8] * centerIndex[2]);
  return m;
}

export { identity, translation };
