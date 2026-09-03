// Port of pv_core/image.py transforms + display state. Constructed from the backend's
// VolumeMeta (which already carries the axis-snapped direction + defaults). All the
// coordinate spaces the Coordinates panel reads out live in matWorldTo().

import type { VolumeMeta, NumericArray, Patient } from '../api/client';
import * as geo from './geometry';
import {
  applyToPoint,
  diag,
  identity,
  invert,
  mul,
  multiply,
  translation,
  vsub,
  type Mat4,
  type Vec3,
} from './mat4';

export const SPACES = [
  'world', 'lps', 'ras', 'patient', 'lai', 'table', 'fs', 'imp',
  'pixel', 'image_world', 'image_mm',
] as const;
export type Space = (typeof SPACES)[number];

export interface RegStep {
  kind: 'rigid' | 'scale' | 'affine';
  mat: Mat4;
}

export class Image {
  id: string;
  name: string;
  size: Vec3;
  spacing: Vec3;
  centerIndex: Vec3; // centre of the FULL grid (see cropOrigin)
  centerPhys: Vec3;
  // A .cdb's images are CROPS that declare their full geometry: `size` is the stored crop, while
  // centerIndex/direction describe the full grid so meshes and electrodes place in the full frame.
  // `cropOrigin` is the crop's first voxel in that grid — pv_core applies it as `vox_matrix` when
  // sampling, and buildVolume uses it to place the texture. [0,0,0] for a normal image.
  cropOrigin: Vec3;
  fullSize: Vec3;
  originPhys: Vec3;
  direction: number[]; // snapped row-major 3x3
  orientationLabel: string;
  /** Workflow slot: 'preop' / 'postop' / 'synthetic'; '' = a plain scan. The processing
   *  steps key off it. */
  role: string;
  patient: Patient;
  valueMin: number;
  valueMax: number;

  // display (2D)
  level: number;
  window: number;
  autoLevel: number;
  autoWindow: number;
  headerLevel: number | null;
  headerWindow: number | null;
  interp: 'linear' | 'nearest' = 'linear';
  colormap: number[][] | null = null; // 256x3
  colormapIndex = 0;
  fgWindow: [number, number]; // foreground intensity range; outside -> transparent
  cropBox: number[] | null = null; // [x0,x1,y0,y1,z0,z1] voxel indices (null = full)
  cropDim = 0.5; // dim opacity outside the crop box
  showCropped = false;
  surfaceThreshold: [number, number] = [500, 3000]; // 3D isosurface [iso, cutoff]
  surfaceStyle = 'opaque';
  render3dMode = 'surface'; // volume | surface | mip | none (pv_core/image.py)

  // placement / registration
  baseWorldMatrix: Mat4 = identity();
  regChain: RegStep[] = [];
  regIndex = -1;
  private rotCenterIw: Vec3 | null = null; // pivot in image-world (tracks the image)

  // pixels (attached after fetchVolume; used for value_at_world + VTK.js upload)
  pixels: NumericArray | null = null;
  dtype: string;

  constructor(meta: VolumeMeta) {
    this.id = meta.id;
    this.name = meta.name;
    this.size = meta.size;
    this.spacing = meta.spacing;
    this.centerIndex = meta.center_index;
    this.centerPhys = meta.center_phys;
    this.cropOrigin = meta.crop_origin ?? [0, 0, 0];
    this.fullSize = meta.full_size ?? meta.size;
    // The placement the backend restored (identity for a plain load; a real transform for a .cdb,
    // whose pair is re-framed onto the atlas). Registration edits compose on top of it as usual.
    if (meta.world_matrix?.length === 16) this.baseWorldMatrix = meta.world_matrix as Mat4;
    this.originPhys = meta.origin_phys;
    this.direction = meta.direction;
    this.orientationLabel = meta.orientation_label;
    this.role = meta.role ?? '';
    this.patient = meta.patient;
    this.valueMin = meta.value_min;
    this.valueMax = meta.value_max;
    this.level = meta.level;
    this.window = meta.window;
    this.autoLevel = meta.level;
    this.autoWindow = meta.window;
    this.headerLevel = meta.header_level;
    this.headerWindow = meta.header_window;
    this.fgWindow = meta.fg_window ?? [meta.value_min, meta.value_max];
    this.dtype = meta.dtype;
    // Display state as the backend restored it (defaults for a plain file load, the plan's
    // saved values for an image out of a workspace — pv_core/workspace.py::apply_record).
    this.interp = meta.interp ?? this.interp;
    this.colormapIndex = meta.colormap_index ?? 0;
    this.cropBox = meta.crop_box ?? null;
    this.showCropped = meta.show_cropped ?? false;
    this.surfaceThreshold = meta.surface_threshold ?? this.surfaceThreshold;
    this.surfaceStyle = meta.surface_style ?? this.surfaceStyle;
    this.render3dMode = meta.render3d_mode ?? this.render3dMode;
  }

  // --- world matrix (base composed with matrix reg steps up to regIndex) -----
  get worldMatrix(): Mat4 {
    let m = this.baseWorldMatrix;
    for (let i = 0; i <= this.regIndex && i < this.regChain.length; i++) {
      const s = this.regChain[i];
      if (s.kind === 'rigid' || s.kind === 'scale' || s.kind === 'affine') {
        m = multiply(m, s.mat);
      }
    }
    return m;
  }

  // --- manual-registration chain (ports pv_core.image) -----------------------
  private static REG_MAT_KINDS = new Set(['rigid', 'scale', 'affine']);

  regPushRigid(mat: Mat4 | null = null, kind: RegStep['kind'] = 'rigid'): void {
    this.regChain.length = this.regIndex + 1; // discard any redo branch
    this.regChain.push({ kind, mat: mat ?? identity() });
    this.regIndex = this.regChain.length - 1;
  }

  regSetCurrent(mat: Mat4): void {
    if (this.regIndex >= 0 && this.regIndex < this.regChain.length) {
      this.regChain[this.regIndex].mat = mat;
    }
  }

  regDropCurrentIfIdentity(): void {
    if (this.regIndex >= 0 && this.regIndex < this.regChain.length) {
      const s = this.regChain[this.regIndex];
      if (Image.REG_MAT_KINDS.has(s.kind) && s.mat.every((v, i) => Math.abs(v - identity()[i]) < 1e-12)) {
        this.regChain.splice(this.regIndex, 1);
        this.regIndex -= 1;
      }
    }
  }

  regUndo(): boolean {
    if (this.regIndex >= 0) {
      this.regIndex -= 1;
      return true;
    }
    return false;
  }

  regRedo(): boolean {
    if (this.regIndex < this.regChain.length - 1) {
      this.regIndex += 1;
      return true;
    }
    return false;
  }

  regCanUndo(): boolean {
    return this.regIndex >= 0;
  }

  regCanRedo(): boolean {
    return this.regIndex < this.regChain.length - 1;
  }

  regClear(): void {
    this.baseWorldMatrix = identity();
    this.regChain = [];
    this.regIndex = -1;
  }

  hasRegistration(): boolean {
    return this.regChain.length > 0 || this.baseWorldMatrix.some((v, i) => Math.abs(v - identity()[i]) > 1e-12);
  }

  /** Manual-registration pivot in global world, or null (stored in image-world so it
   *  moves with the image as registration changes). */
  get rotCenter(): Vec3 | null {
    if (this.rotCenterIw === null) return null;
    return applyToPoint(invert(this.worldMatrix), this.rotCenterIw);
  }

  set rotCenter(world: Vec3 | null) {
    this.rotCenterIw = world === null ? null : applyToPoint(this.worldMatrix, world);
  }

  // --- transforms ------------------------------------------------------------
  matPixelToImageWorld(): Mat4 {
    return geo.pixelToImageWorld(this.spacing, this.centerIndex, this.direction);
  }

  matWorldToPixel(): Mat4 {
    return multiply(invert(this.matPixelToImageWorld()), this.worldMatrix);
  }

  matPixelToWorld(): Mat4 {
    return invert(this.matWorldToPixel());
  }

  private lpsOffset(): Vec3 {
    return vsub(this.centerPhys, this.originPhys);
  }

  matWorldToLps(): Mat4 {
    return multiply(translation(this.lpsOffset()), this.worldMatrix);
  }

  matPixelToLps(): Mat4 {
    return multiply(translation(this.lpsOffset()), this.matPixelToImageWorld());
  }

  /** (min, max) LPS over the 8 voxel corners — intrinsic (no world matrix). */
  private lpsBbox(): { lo: Vec3; hi: Vec3 } {
    const n: Vec3 = [this.size[0] - 1, this.size[1] - 1, this.size[2] - 1];
    const m = this.matPixelToLps();
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const i of [0, n[0]])
      for (const j of [0, n[1]])
        for (const k of [0, n[2]]) {
          const p = applyToPoint(m, [i, j, k]);
          for (let a = 0; a < 3; a++) {
            if (p[a] < lo[a]) lo[a] = p[a];
            if (p[a] > hi[a]) hi[a] = p[a];
          }
        }
    return { lo, hi };
  }

  /** 4x4 mapping global-world -> the named space (single source of truth). */
  matWorldTo(space: Space): Mat4 {
    if (space === 'world') return identity();
    if (space === 'pixel') return this.matWorldToPixel();
    if (space === 'image_world') return this.worldMatrix;
    if (space === 'image_mm')
      return multiply(diag([...this.spacing, 1] as [number, number, number, number]), this.matWorldToPixel());

    const toLps = this.matWorldToLps();
    if (space === 'lps') return toLps;
    if (space === 'ras') return multiply(geo.LPS_TO_RAS, toLps);
    if (space === 'table')
      return mul(geo.LPS_TO_RAS, translation(this.originPhys), toLps);
    if (space === 'patient') {
      const { lo, hi } = this.lpsBbox();
      const las: Vec3 = [hi[0], lo[1], hi[2]]; // L-most, A-most, S-most
      return mul(diag([-1, 1, -1, 1]), translation([-las[0], -las[1], -las[2]]), toLps);
    }
    if (space === 'lai') {
      const { lo, hi } = this.lpsBbox();
      const rps: Vec3 = [lo[0], hi[1], hi[2]]; // R-most, P-most, S-most
      return mul(diag([1, -1, -1, 1]), translation([-rps[0], -rps[1], -rps[2]]), toLps);
    }
    if (space === 'fs') {
      const center: Vec3 = [
        Math.floor(this.size[0] / 2),
        Math.floor(this.size[1] / 2),
        Math.floor(this.size[2] / 2),
      ];
      const fsCenter = applyToPoint(this.matPixelToLps(), center);
      return mul(geo.LPS_TO_RAS, translation([-fsCenter[0], -fsCenter[1], -fsCenter[2]]), toLps);
    }
    if (space === 'imp') {
      const { lo } = this.lpsBbox();
      // voxsize_lps = |direction| @ spacing
      const d = this.direction;
      const vox: Vec3 = [
        Math.abs(d[0]) * this.spacing[0] + Math.abs(d[1]) * this.spacing[1] + Math.abs(d[2]) * this.spacing[2],
        Math.abs(d[3]) * this.spacing[0] + Math.abs(d[4]) * this.spacing[1] + Math.abs(d[5]) * this.spacing[2],
        Math.abs(d[6]) * this.spacing[0] + Math.abs(d[7]) * this.spacing[1] + Math.abs(d[8]) * this.spacing[2],
      ];
      const scale = diag([1 / vox[0], 1 / vox[1], 1 / vox[2], 1]);
      return mul(scale, translation([-lo[0], -lo[1], -lo[2]]), toLps);
    }
    throw new Error(`unknown space: ${space}`);
  }

  worldTo(space: Space, pt: Vec3): Vec3 {
    return applyToPoint(this.matWorldTo(space), pt);
  }

  worldFrom(space: Space, pt: Vec3): Vec3 {
    return applyToPoint(invert(this.matWorldTo(space)), pt);
  }

  pixelToWorld(pt: Vec3): Vec3 {
    return applyToPoint(this.matPixelToWorld(), pt);
  }

  worldToPixel(pt: Vec3): Vec3 {
    return applyToPoint(this.matWorldToPixel(), pt);
  }

  fullCropBox(): number[] {
    return [0, this.size[0] - 1, 0, this.size[1] - 1, 0, this.size[2] - 1];
  }

  cropBoxOrFull(): number[] {
    return this.cropBox ? [...this.cropBox] : this.fullCropBox();
  }

  /** Nearest-voxel intensity at a global-world point, or null if outside. */
  valueAtWorld(pt: Vec3): number | null {
    if (!this.pixels) return null;
    const ijk = this.worldToPixel(pt).map((v) => Math.round(v)) as Vec3;
    const [sx, sy, sz] = this.size;
    if (ijk[0] < 0 || ijk[0] >= sx || ijk[1] < 0 || ijk[1] >= sy || ijk[2] < 0 || ijk[2] >= sz)
      return null;
    // pixels are x-fastest (VTK order): index = i + sx*(j + sy*k)
    return this.pixels[ijk[0] + sx * (ijk[1] + sy * ijk[2])];
  }
}
