// Reslice geometry + vtkImageData construction (no rendering imports, so this is
// unit-testable in node). Ports the desktop reslice_view.py math: a world plane
// (u,v,n through the crosshair) mapped into image voxel space by mat_world_to_pixel,
// handed to vtkImageReslice as its ResliceAxes, output raster sized to the pane.

import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageReslice from '@kitware/vtk.js/Imaging/Core/ImageReslice';
import { InterpolationMode } from '@kitware/vtk.js/Imaging/Core/AbstractImageInterpolator/Constants';
import type { Image } from '../core/image';
import { fromColumns, multiply, type Mat4, type Vec3 } from '../core/mat4';
import { viewAxes, type ViewName, type ViewState } from '../core/scene';

/** vtk.js matrices are column-major Float32 (gl-matrix mat4); our Mat4 is row-major.
 *  Transpose + widen to hand off to vtk.js. */
export function toColMajor(m: Mat4): Float32Array {
  const c = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) c[col * 4 + r] = m[r * 4 + col];
  return c;
}

/** vtkImageData on a plain index grid (spacing 1, origin 0) — desktop `raw_grid`.
 *  Geometry lives entirely in the reslice matrix, so voxels are used as stored. */
export function buildUnitGrid(
  pixels: ArrayBufferView & ArrayLike<number>,
  size: Vec3,
): vtkImageData {
  const img = vtkImageData.newInstance();
  img.setDimensions(size as number[]);
  img.setSpacing([1, 1, 1]);
  img.setOrigin([0, 0, 0]);
  const scalars = vtkDataArray.newInstance({
    numberOfComponents: 1,
    values: pixels,
    name: 'scalars',
  });
  img.getPointData().setScalars(scalars);
  return img;
}

export interface ResliceParams {
  axesRowMajor: Mat4; // output-slice coords -> image voxel index
  axesColMajor: Float32Array; // same, column-major for vtk.js
  spacing: [number, number, number];
  origin: [number, number, number];
  extent: [number, number, number, number, number, number];
  px: number; // mm per output pixel
  u: Vec3;
  v: Vec3;
  n: Vec3;
  planeOrigin: Vec3;
}

/** Reslice parameters for one MPR pane: the world plane through the crosshair with the
 *  view's (u,v,n) basis, mapped into the image, output raster sized to (w,h) pixels. */
export function resliceParams(
  image: Image,
  view: ViewName,
  vs: ViewState,
  w: number,
  h: number,
  planeCenter?: Vec3,
): ResliceParams {
  const [u, v, n] = viewAxes(view, vs.radiological, vs.orientation);
  const o: Vec3 = planeCenter ?? (vs.crosshair as Vec3);
  const p = fromColumns(u, v, n, o); // world plane basis (columns u,v,n,origin)
  const axesRowMajor = multiply(image.matWorldToPixel(), p);
  const fov = vs.fovMm / vs.zoom;
  const px = fov / h;
  return {
    axesRowMajor,
    axesColMajor: toColMajor(axesRowMajor),
    spacing: [px, px, 1],
    origin: [(-(w - 1) / 2) * px, (-(h - 1) / 2) * px, 0],
    extent: [0, w - 1, 0, h - 1, 0, 0],
    px,
    u,
    v,
    n,
    planeOrigin: o,
  };
}

/** CPU reslice of one image to a w*h scalar raster (x-fastest, j=0 = bottom row).
 *  Used by the overlay tool's stencil compositing (desktop technique). */
export function resliceToScalars(
  grid: vtkImageData,
  image: Image,
  view: ViewName,
  vs: ViewState,
  w: number,
  h: number,
  o: Vec3,
): ArrayLike<number> {
  const p = resliceParams(image, view, vs, w, h, o);
  const r = vtkImageReslice.newInstance();
  r.setInputData(grid);
  r.setOutputDimensionality(2);
  r.setInterpolationMode(image.interp === 'nearest' ? InterpolationMode.NEAREST : InterpolationMode.LINEAR);
  r.setResliceAxes(p.axesColMajor);
  r.setOutputSpacing(p.spacing);
  r.setOutputOrigin(p.origin);
  r.setOutputExtent(p.extent);
  r.setBackgroundColor([image.level - image.window, 0, 0, 0]);
  return r.getOutputData().getPointData().getScalars().getData();
}
