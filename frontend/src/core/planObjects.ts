// TS mirror of the parts of pv_core/plan_objects.py the viewer displays, plus the CIP preop
// payload each trajectory carries in `extra.cip`. The backend (routes/plan.py) has already
// mapped every point into GLOBAL WORLD and moved the vertex arrays out into mesh blobs, so
// everything here is directly renderable — no image-frame math on the client.

import type { Vec3 } from './mat4';
import { vadd, vnorm, vscale, vsub } from './mat4';

/** Scala-tympani A/B width measures (structure `extra.ab`). */
export interface AbMeasure {
  a: number;
  b: number;
  pa: number[][]; // 2 world points
  pb: number[][];
}

/** CIP insertion payload (`trajectory.extra.cip`) — see projects/cip/preop_plan.py. */
export interface CipTraj {
  approach: string; // Cochleostomy | RWcenter | RW
  label: string; // short column header: Coch. / RW Ctr / RW
  electrode_id: number;
  tilt: number;
  depth: number;
  curl_angle: number;
  rw_angle: number;
  curl_clock: string;
  rw_clock: string;
  dist_fn: number;
  dist_chorda: number;
  dist_ossicles: number;
  points: number[][]; // 10 guidance points (world) — see GUIDANCE_POINTS below
  t2w: number[][] | null; // 4x4 trajectory frame -> world
  desc: string[]; // surgical guidance lines
  carrier_mesh: null; // stripped by the backend; the geometry is a mesh blob
}

export interface PlanStructure {
  kind: 'structure';
  id: string;
  name: string;
  color: [number, number, number];
  visible: boolean;
  opacity: number;
  source_image: string | null;
  coord_space: string;
  mesh: null;
  extra: { ab?: AbMeasure; idl_id?: number; side?: string };
}

export interface PlanTrajectory {
  kind: 'trajectory';
  id: string;
  name: string;
  color: [number, number, number];
  visible: boolean;
  side: string;
  entry: number[] | null;
  target: number[] | null;
  device_model: string;
  extra: { cip?: CipTraj };
}

/** One electrode contact of a localized lead (pv_core plan_objects.Contact + the CIP fields).
 *  `position` is global world — the backend baked it (backend/bake.py). */
export interface PlanContact {
  index: number; // < 0 = an IDL placeholder / 'fake' electrode
  label: string;
  position: number[] | null;
  angle: number | null;
  angle_user: number | null;
  scala: number | null; // 0 OC / 1 ST / 2 SV / 3 BM
  scala_user: number | null;
}

/** A localized electrode lead (a .cdb's postop reconstruction). The analytic `cie` payload is
 *  stripped by the backend; its derived series come from /api/cdb/{id}/graph. */
export interface PlanLead {
  kind: 'lead';
  id: string;
  name: string;
  model: string;
  side: string;
  color: [number, number, number];
  visible: boolean;
  source_image: string | null;
  coord_space: string;
  contacts: PlanContact[];
  cur_setting: number;
}

export type PlanObject =
  | PlanStructure
  | PlanTrajectory
  | PlanLead
  | { kind: string; id: string };

export interface PlanSession {
  objects: PlanObject[];
  state: Record<string, unknown>; // module / side / cip block
}

export function planStructures(session: PlanSession | null): PlanStructure[] {
  return (session?.objects ?? []).filter((o): o is PlanStructure => o.kind === 'structure');
}

export function planTrajectories(session: PlanSession | null): PlanTrajectory[] {
  return (session?.objects ?? []).filter((o): o is PlanTrajectory => o.kind === 'trajectory');
}

export function planLead(session: PlanSession | null): PlanLead | null {
  return (session?.objects ?? []).find((o): o is PlanLead => o.kind === 'lead') ?? null;
}

/** A .cdb opens read-only (cdb_scene.assemble sets it) — every clinician edit is disabled, as in
 *  the desktop (electrode_panel._edits_locked). */
export function isReadOnly(session: PlanSession | null): boolean {
  const cip = (session?.state?.cip ?? {}) as { read_only?: boolean };
  return Boolean(cip.read_only);
}

// --- structures ------------------------------------------------------------------------

/** Row text for the structures checklist. CIP smuggles the scala-tympani measurements into
 *  the name ('R. Scala Tympani  (A=8.6,B=6.2)'); the importer split them into extra.ab, so
 *  put them back for display only. Port of desktop/structures_panel.py::structure_label. */
export function structureLabel(s: PlanStructure): string {
  const ab = s.extra?.ab;
  if (ab && ab.a != null && ab.b != null) return `${s.name}  (A=${g(ab.a)},B=${g(ab.b)})`;
  return s.name;
}

/** Python's '%g' for the A/B values (8.6, not 8.600000). */
function g(v: number): string {
  return String(Number(Number(v).toPrecision(6)));
}

// --- trajectories ----------------------------------------------------------------------

/** Sentinel active-trajectory id meaning "draw every trajectory" (the panel's 'All' item).
 *  four_up_viewer.ALL_TRAJECTORIES. */
export const ALL_TRAJECTORIES = '__all__';

/** A preop trajectory is only a few mm long; like IDL's _DrawTraj it is drawn as a line
 *  extended from the target through the entry to this length (four_up_viewer). */
export const TRAJ_DISPLAY_LEN = 30.0;

/** (target, far end) of the drawn trajectory line, in world.
 *  Port of four_up_viewer._traj_display_line. */
export function trajDisplayLine(t: PlanTrajectory): [Vec3, Vec3] | null {
  if (!t.entry || !t.target) return null;
  const entry = t.entry as Vec3;
  const target = t.target as Vec3;
  const d = vsub(entry, target);
  const n = vnorm(d);
  if (n < 1e-6) return [target, entry];
  return [target, vadd(target, vscale(d, TRAJ_DISPLAY_LEN / n))];
}

/** Midpoint of a trajectory — where selecting it parks the crosshair (set_active_trajectory). */
export function trajCenter(t: PlanTrajectory): Vec3 | null {
  if (!t.entry || !t.target) return null;
  return vscale(vadd(t.entry as Vec3, t.target as Vec3), 0.5);
}

/** Indices into cip.points, named as four_up_viewer._build_traj_accessories uses them. */
export const GUIDANCE_POINTS = {
  curlCenter: 0,
  curlNormal: 1,
  curlFootplate: 2,
  curlHand: 3,
  rwCenter: 4,
  rwNormal: 5,
  rwFootplate: 6,
  rwHand: 7,
  rwPlaneNormal: 8,
  stapesFootplate: 9,
} as const;

/** Column order of the approaches in the insertion table (trajectory_panel._APPROACH_ORDER). */
export const APPROACH_ORDER: Record<string, number> = { Cochleostomy: 0, RWcenter: 1, RW: 2 };

/** Insertion-table rows: short label (narrow row header), cip key, full tooltip.
 *  Port of desktop/trajectory_panel.py::_ROWS. */
export const TRAJ_ROWS: { label: string; key: keyof CipTraj; tip: string }[] = [
  { label: 'F. Nerve', key: 'dist_fn', tip: 'Distance of the insertion trajectory from the Facial Nerve (mm)' },
  { label: 'Chorda', key: 'dist_chorda', tip: 'Distance of the insertion trajectory from the Chorda (mm)' },
  { label: 'Ossicles', key: 'dist_ossicles', tip: 'Distance of the insertion trajectory from the Ossicles (mm)' },
  { label: 'Tilt', key: 'tilt', tip: 'Tilt of the trajectory with the round-window plane (deg; 0 = perpendicular)' },
  { label: 'Curl', key: 'curl_clock', tip: 'Curl direction (Stapes foot-plate = 12:00)' },
  { label: 'Insertion', key: 'rw_clock', tip: 'Round-window insertion direction (Stapes foot-plate = 12:00)' },
  { label: 'Depth', key: 'depth', tip: 'Insertion depth (mm)' },
];

/** One cell of the insertion table. Distances/depth to 1 decimal, tilt to 0, clocks verbatim;
 *  '+ 0.0' clears a display '-0.0' exactly as trajectory_panel._fill_table's num() does. */
export function trajCell(cip: CipTraj | undefined, key: keyof CipTraj): string {
  if (!cip) return '';
  const v = cip[key];
  if (typeof v === 'string') return v;
  if (typeof v !== 'number') return '';
  const nd = key === 'tilt' ? 0 : 1;
  const r = Number(v.toFixed(nd)) + 0.0;
  return r.toFixed(nd);
}

/** The approaches shown as the table's columns: every trajectory of the same electrode model
 *  as `chosen`, in approach order (trajectory_panel._fill_for). */
export function approachSiblings(trajs: PlanTrajectory[], chosen: PlanTrajectory | null): PlanTrajectory[] {
  if (!chosen) return [];
  const eid = chosen.extra?.cip?.electrode_id;
  return trajs
    .filter((t) => t.extra?.cip?.electrode_id === eid)
    .sort((a, b) => (APPROACH_ORDER[a.extra?.cip?.approach ?? ''] ?? 9) - (APPROACH_ORDER[b.extra?.cip?.approach ?? ''] ?? 9));
}
