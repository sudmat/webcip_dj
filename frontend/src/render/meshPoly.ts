// Shared SurfaceMesh -> vtkPolyData builder (used by View3D and the 2D cross-section overlay).
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import type { SurfaceMesh } from '../api/client';

export function meshToPolyData(mesh: SurfaceMesh): vtkPolyData {
  const pd = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  pts.setData(mesh.points, 3);
  pd.setPoints(pts);
  const n = mesh.tris.length / 3;
  const conn = new Uint32Array(n * 4); // vtk cell format: [3, i, j, k, 3, ...]
  for (let t = 0; t < n; t++) {
    conn[t * 4] = 3;
    conn[t * 4 + 1] = mesh.tris[t * 3];
    conn[t * 4 + 2] = mesh.tris[t * 3 + 1];
    conn[t * 4 + 3] = mesh.tris[t * 3 + 2];
  }
  const polys = vtkCellArray.newInstance();
  polys.setData(conn);
  pd.setPolys(polys);
  pd.getPointData().setNormals(
    vtkDataArray.newInstance({ numberOfComponents: 3, values: mesh.normals, name: 'Normals' }),
  );
  return pd;
}
