import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { VolumeMeta } from '../../api/client';
import { Image, SPACES, type Space } from '../image';
import { orientationLabel, nearestAxisAligned } from '../geometry';
import { COORD_SYSTEMS, toValues, fromValues, visibleSystems, IMAGE_LOADED, ALWAYS } from '../coords';
import type { Vec3 } from '../mat4';

const ref = JSON.parse(
  readFileSync(new URL('./reference.json', import.meta.url), 'utf8'),
) as Reference;

interface SpaceRef {
  mat: number[];
  world_to: number[][];
}
interface ImageRef {
  meta: VolumeMeta;
  spaces: Record<string, SpaceRef>;
}
interface Reference {
  real: ImageRef;
  synthetic: ImageRef;
  orientation_label: Record<string, string>;
  nearest_axis_aligned: Record<string, number[]>;
  sample_pts: number[][];
}

const TOL = 1e-6;

function expectClose(a: number[], b: number[], tol = TOL) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
}

for (const key of ['real', 'synthetic'] as const) {
  describe(`Image transforms — ${key}`, () => {
    const imgRef = ref[key];
    const img = new Image(imgRef.meta);
    const pts = ref.sample_pts as Vec3[];

    for (const sp of SPACES) {
      it(`matWorldTo(${sp}) matches pv_core`, () => {
        expectClose(img.matWorldTo(sp as Space), imgRef.spaces[sp].mat);
      });

      it(`worldTo(${sp}) matches pv_core at sample points`, () => {
        pts.forEach((p, i) => {
          expectClose(img.worldTo(sp as Space, p), imgRef.spaces[sp].world_to[i]);
        });
      });

      it(`worldFrom(worldTo(${sp})) round-trips`, () => {
        pts.forEach((p) => {
          const back = img.worldFrom(sp as Space, img.worldTo(sp as Space, p));
          expectClose(back, p, 1e-6);
        });
      });
    }

    it('pixel<->world round-trips', () => {
      pts.forEach((p) => {
        expectClose(img.pixelToWorld(img.worldToPixel(p)), p, 1e-6);
      });
    });
  });
}

describe('geometry helpers', () => {
  it('orientationLabel matches pv_core', () => {
    expect(orientationLabel([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(ref.orientation_label.identity);
    expect(orientationLabel([0, 0, 1, 1, 0, 0, 0, 1, 0])).toBe(ref.orientation_label.perm);
    expect(orientationLabel([-1, 0, 0, 0, -1, 0, 0, 0, 1])).toBe(ref.orientation_label.flip);
  });

  it('nearestAxisAligned snaps oblique like pv_core', () => {
    const got = nearestAxisAligned([0.98, 0.1, 0.0, -0.1, 0.98, 0.0, 0.0, 0.0, 1.0]);
    expectClose(got, ref.nearest_axis_aligned.oblique, 1e-12);
  });
});

describe('registration chain', () => {
  const img = new Image(ref.real.meta);
  const p: Vec3 = [3, -4, 5];
  const base = img.pixelToWorld(p);

  it('translate step shifts the image placement by +d (undo/redo restore)', () => {
    const d: Vec3 = [10, -6, 2];
    // desktop stores inv(motion) as the chain step; motion = translation(d)
    img.regPushRigid();
    img.regSetCurrent([1, 0, 0, -d[0], 0, 1, 0, -d[1], 0, 0, 1, -d[2], 0, 0, 0, 1]); // inv(T(d))
    expectClose(img.pixelToWorld(p), [base[0] + d[0], base[1] + d[1], base[2] + d[2]], 1e-6);
    expect(img.regCanUndo()).toBe(true);
    img.regUndo();
    expectClose(img.pixelToWorld(p), base, 1e-9);
    img.regRedo();
    expectClose(img.pixelToWorld(p), [base[0] + d[0], base[1] + d[1], base[2] + d[2]], 1e-6);
    img.regClear();
    expectClose(img.pixelToWorld(p), base, 1e-9);
  });

  it('rotCenter round-trips through world<->image-world', () => {
    const c: Vec3 = [1, 2, 3];
    img.rotCenter = c;
    expectClose(img.rotCenter as number[], c, 1e-9);
    img.rotCenter = null;
    expect(img.rotCenter).toBeNull();
  });
});

describe('coords panel', () => {
  const img = new Image(ref.real.meta);
  const cross: Vec3 = [10, -20, 30];

  it('CT Patient values equal image.worldTo(patient)', () => {
    const ct = COORD_SYSTEMS.find((s) => s.id === 'CT_PATIENT')!;
    const vals = toValues(ct, img, cross, [0, 0, 0]);
    expectClose(vals, img.worldTo('patient', cross));
  });

  it('toValues/fromValues round-trip (Scan1 RAS)', () => {
    const s = COORD_SYSTEMS.find((sy) => sy.id === 'SCAN1_RAS')!;
    const vals = toValues(s, img, cross, [0, 0, 0]);
    expectClose(fromValues(s, img, vals, [0, 0, 0]), cross);
  });

  it('visibleSystems gates on conditions', () => {
    const none = visibleSystems([ALWAYS]);
    expect(none.map((s) => s.id)).toEqual(['CT_PATIENT']);
    const loaded = visibleSystems([ALWAYS, IMAGE_LOADED]);
    expect(loaded.some((s) => s.id === 'SCAN1_RAS')).toBe(true);
    expect(loaded.some((s) => s.id === 'ATLAS_W')).toBe(false);
  });
});
