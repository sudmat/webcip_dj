// Headless proof of the V1 reslice geometry: drive the real vtk.js vtkImageReslice
// (a CPU data filter — no WebGL) and confirm each output pixel equals the volume
// intensity at the world point that pixel corresponds to (computed independently via
// image.valueAtWorld). If these agree for all three planes, the reslice axes / output
// raster geometry is correct regardless of on-screen rendering.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vtkImageReslice from '@kitware/vtk.js/Imaging/Core/ImageReslice';
import { InterpolationMode } from '@kitware/vtk.js/Imaging/Core/AbstractImageInterpolator/Constants';
import type { VolumeMeta } from '../../api/client';
import { Image } from '../../core/image';
import { ViewState, type ViewName } from '../../core/scene';
import { buildUnitGrid, resliceParams } from '../reslice';
import { applyToPoint, invert, type Vec3 } from '../../core/mat4';

// Reuse the core reference fixture's meta; synth the pixels deterministically so
// valueAtWorld and the reslice sample the same data.
const ref = JSON.parse(
  readFileSync(new URL('../../core/__tests__/reference.json', import.meta.url), 'utf8'),
) as { real: { meta: VolumeMeta } };

function syntheticPixels(size: Vec3): Int16Array {
  const [sx, sy, sz] = size;
  const a = new Int16Array(sx * sy * sz);
  // a smooth, non-degenerate field so nearest-sampling is unambiguous per voxel
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) a[i + sx * (j + sy * k)] = (i * 7 + j * 13 + k * 17) % 4000;
  return a;
}

describe('V1 reslice geometry (vtkImageReslice)', () => {
  const meta = ref.real.meta;
  const size = meta.size as Vec3;
  const pixels = syntheticPixels(size);
  const image = new Image(meta);
  image.pixels = pixels;
  const grid = buildUnitGrid(pixels, size);

  const W = 64;
  const H = 64;

  for (const view of ['axial', 'sagittal', 'coronal'] as ViewName[]) {
    it(`${view}: resliced pixels == valueAtWorld at their world points`, () => {
      const vs = new ViewState();
      // put the crosshair at the volume centre so the plane sits inside the data
      vs.crosshair = image.pixelToWorld([
        (size[0] - 1) / 2,
        (size[1] - 1) / 2,
        (size[2] - 1) / 2,
      ]);

      const p = resliceParams(image, view, vs, W, H);

      const reslice = vtkImageReslice.newInstance();
      reslice.setInputData(grid);
      reslice.setOutputDimensionality(2);
      reslice.setInterpolationMode(InterpolationMode.NEAREST);
      reslice.setResliceAxes(p.axesColMajor);
      reslice.setOutputSpacing(p.spacing);
      reslice.setOutputOrigin(p.origin);
      reslice.setOutputExtent(p.extent);
      const out = reslice.getOutputData();
      const outScalars = out.getPointData().getScalars().getData();

      // output-slice coords -> world: inverse of (matWorldToPixel) applied after axes,
      // simplest is to go output pixel -> output-mm -> world via the plane basis.
      const { u, v, n, planeOrigin, px } = p;
      const worldOf = (ox: number, oy: number): Vec3 => {
        const mx = (ox - (W - 1) / 2) * px;
        const my = (oy - (H - 1) / 2) * px;
        return [
          planeOrigin[0] + u[0] * mx + v[0] * my,
          planeOrigin[1] + u[1] * mx + v[1] * my,
          planeOrigin[2] + u[2] * mx + v[2] * my,
        ];
      };

      // sample a grid of output pixels; skip any that fall outside the volume
      let checked = 0;
      let mismatched = 0;
      for (let oy = 2; oy < H; oy += 3) {
        for (let ox = 2; ox < W; ox += 3) {
          const world = worldOf(ox, oy);
          const expected = image.valueAtWorld(world);
          if (expected === null) continue; // outside volume -> reslice background, skip
          const got = outScalars[oy * W + ox];
          checked++;
          if (got !== expected) mismatched++;
        }
      }
      expect(checked).toBeGreaterThan(20); // the plane really intersects the data
      expect(mismatched).toBe(0);
      // silence unused (n only documents the slice normal)
      void n;
      void invert;
      void applyToPoint;
    });
  }
});
