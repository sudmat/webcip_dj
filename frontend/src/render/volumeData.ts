// Build a 3D vtkImageData placed in global-world with the image's real geometry
// (unregistered case), shared by the 2D panes (texture for reslice) and the 3D view.
// index -> world = direction @ diag(spacing) @ (index - centre), matching image.pixelToWorld.
//
// For a CROPPED image (a .cdb's preop/postop) the stored array starts at full-grid index
// `cropOrigin`, so the placement is (cropOrigin - centre), not (-centre) — pv_core does the same
// through Image.vox_matrix. cropOrigin is [0,0,0] for a normal image, leaving that case unchanged.

import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import type { Image } from '../core/image';
import type { Vec3 } from '../core/mat4';

export function buildVolume(image: Image): vtkImageData {
  const img = vtkImageData.newInstance();
  img.setDimensions(image.size as number[]);
  img.setSpacing(image.spacing as number[]);
  const d = image.direction; // row-major 3x3
  img.setDirection([d[0], d[3], d[6], d[1], d[4], d[7], d[2], d[5], d[8]]); // -> column-major
  const s = image.spacing;
  const c = image.centerIndex;
  const o = image.cropOrigin;
  const sc: Vec3 = [s[0] * (o[0] - c[0]), s[1] * (o[1] - c[1]), s[2] * (o[2] - c[2])];
  img.setOrigin([
    d[0] * sc[0] + d[1] * sc[1] + d[2] * sc[2],
    d[3] * sc[0] + d[4] * sc[1] + d[5] * sc[2],
    d[6] * sc[0] + d[7] * sc[1] + d[8] * sc[2],
  ]);
  img.getPointData().setScalars(
    vtkDataArray.newInstance({ numberOfComponents: 1, values: image.pixels!, name: 'scalars' }),
  );
  return img;
}
