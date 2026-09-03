// A displayed structure/implant mesh. Geometry is already in the renderer's world frame;
// appearance comes either from the backend case manifest (config/mesh colors) or, for a
// loaded plan, from the plan object itself.
import type { SurfaceMesh, MeshManifestItem } from '../api/client';
import type { PlanStructure, PlanTrajectory } from './planObjects';

export type MeshGroup = 'structures' | 'implants';

/** Where a displayed mesh came from — panels list only 'plan-structure' in the checklist,
 *  and the trajectory meshes follow the Trajectories/Guidance toggles instead. */
export type MeshOrigin = 'case' | 'plan-structure' | 'plan-carrier' | 'plan-track';

export interface Structure {
  id: string; // `${group}:${index}`, or the plan object's id
  group: MeshGroup;
  index: number;
  origin: MeshOrigin;
  name: string;
  label: string;
  typeId: number;
  color: [number, number, number]; // 0-1 for vtk
  opacity: number;
  renderOrder: number; // v2 renderOrder; higher draws on top of coincident lower ones
  visible: boolean; // 3D visibility (v2 meshDisplay)
  visible2d: boolean; // 2D cross-section overlay visibility (v2 "label" toggle)
  mesh: SurfaceMesh;
}

export function makeStructure(group: MeshGroup, item: MeshManifestItem, mesh: SurfaceMesh): Structure {
  return {
    id: `${group}:${item.index}`,
    group,
    index: item.index,
    origin: 'case',
    name: item.name,
    label: item.label,
    typeId: item.type_id,
    color: [item.color[0] / 255, item.color[1] / 255, item.color[2] / 255],
    opacity: item.opacity,
    renderOrder: item.render_order,
    visible: true,
    visible2d: true,
    mesh,
  };
}

// Plan meshes are not v2 case meshes: typeId 0 keeps the v2-display appearance rules
// (HIDE_IN_2D / OVERLAY_2D_COLOR / STROKE_IN_2D in render/overlay/types.ts) out of the way,
// so a plan structure is drawn in its own colour in both 2D and 3D, like the desktop.
const PLAN_TYPE_ID = 0;

/** A segmented structure from a loaded plan (pv_core plan_objects.Structure). */
export function makePlanStructure(s: PlanStructure, mesh: SurfaceMesh, index: number): Structure {
  return {
    id: s.id,
    group: 'structures',
    index,
    origin: 'plan-structure',
    name: s.name,
    label: s.name,
    typeId: PLAN_TYPE_ID,
    color: [s.color[0], s.color[1], s.color[2]],
    opacity: s.opacity,
    renderOrder: 0,
    // The desktop's 2D contour pass filters by the same `visible` flag the 3D actors use
    // (four_up_viewer._refresh_2d), so the two track each other for plan structures.
    visible: s.visible,
    visible2d: s.visible,
    mesh,
  };
}

// The trajectory's own meshes, coloured as the desktop draws them: the translucent yellow
// track cylinder (_track_actor) and the translucent orange carrier coil (_carrier_actor).
const TRAJ_MESH_STYLE = {
  'plan-track': { color: [1, 1, 0] as [number, number, number], suffix: 'track' },
  'plan-carrier': { color: [1, 0.6, 0.1] as [number, number, number], suffix: 'carrier' },
};

/** The track cylinder / carrier coil belonging to one trajectory. Visibility is driven by
 *  the Trajectories and Guidance toggles, not by the structures checklist. */
export function makeTrajMesh(
  origin: 'plan-track' | 'plan-carrier',
  t: PlanTrajectory,
  mesh: SurfaceMesh,
  index: number,
): Structure {
  const style = TRAJ_MESH_STYLE[origin];
  return {
    id: `${style.suffix}:${t.id}`,
    group: 'implants',
    index,
    origin,
    name: `${t.name} ${style.suffix}`,
    label: style.suffix,
    typeId: PLAN_TYPE_ID,
    color: style.color,
    opacity: 0.5,
    renderOrder: 0,
    visible: false, // the controller turns these on per the active trajectory + toggles
    visible2d: false,
    mesh,
  };
}
