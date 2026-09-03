// Row-major 4x4 matrix math matching numpy semantics exactly: a point transforms as
// out = M @ [x,y,z,1] (translation in the last column, m[row*4+col]). This mirrors
// pv_core/geometry.py so the port is literal and verifiable against Python.

export type Mat4 = number[]; // length 16, row-major
export type Vec3 = [number, number, number];

export function identity(): Mat4 {
  // prettier-ignore
  return [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1];
}

export function clone(m: Mat4): Mat4 {
  return m.slice();
}

/** a @ b (matrix product, row-major). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

/** Chain of products left-to-right: mul(A, B, C) = A @ B @ C. */
export function mul(...ms: Mat4[]): Mat4 {
  return ms.reduce((acc, m) => multiply(acc, m));
}

export function translation(t: Vec3): Mat4 {
  const m = identity();
  m[3] = t[0];
  m[7] = t[1];
  m[11] = t[2];
  return m;
}

/** 4x4 rotation by `theta` rad about `axis` (Rodrigues), optionally through `center`. */
export function rotation(axis: Vec3, theta: number, center?: Vec3): Mat4 {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len;
  const y = axis[1] / len;
  const z = axis[2] / len;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  // prettier-ignore
  const r: Mat4 = [
    t*x*x + c,   t*x*y - s*z, t*x*z + s*y, 0,
    t*x*y + s*z, t*y*y + c,   t*y*z - s*x, 0,
    t*x*z - s*y, t*y*z + s*x, t*z*z + c,   0,
    0, 0, 0, 1,
  ];
  if (!center) return r;
  return mul(translation(center), r, translation([-center[0], -center[1], -center[2]]));
}

/** diag(d0,d1,d2,d3). */
export function diag(d: [number, number, number, number]): Mat4 {
  const m = identity();
  m[0] = d[0];
  m[5] = d[1];
  m[10] = d[2];
  m[15] = d[3];
  return m;
}

/** Build a 4x4 whose columns are u, v, n and the origin o (the reslice plane basis). */
export function fromColumns(u: Vec3, v: Vec3, n: Vec3, o: Vec3): Mat4 {
  // prettier-ignore
  return [
    u[0], v[0], n[0], o[0],
    u[1], v[1], n[1], o[1],
    u[2], v[2], n[2], o[2],
    0,    0,    0,    1,
  ];
}

/** Set the top-left 3x3 from a row-major 9-array; identity translation. */
export function from3x3(d9: number[]): Mat4 {
  const m = identity();
  m[0] = d9[0]; m[1] = d9[1]; m[2] = d9[2];
  m[4] = d9[3]; m[5] = d9[4]; m[6] = d9[5];
  m[8] = d9[6]; m[9] = d9[7]; m[10] = d9[8];
  return m;
}

/** Apply to a point (homogeneous w = 1). */
export function applyToPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** Apply only the 3x3 rotation/scale part to a vector (ignore translation). */
export function applyToVector(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

/** General 4x4 inverse (adjugate / determinant). Throws if singular. */
export function invert(m: Mat4): Mat4 {
  const inv = new Array(16);
  inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (det === 0) throw new Error('mat4.invert: singular matrix');
  det = 1.0 / det;
  return inv.map((x) => x * det);
}

// --- small vec3 helpers -----------------------------------------------------
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vnorm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
