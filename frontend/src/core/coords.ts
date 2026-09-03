// Port of pv_core/coords.py — the Coordinates read-out panel's system definitions.
// Each system references an image space (Image.SPACES) and per-axis direction options.

import type { Image } from './image';
import type { Space } from './image';
import type { Vec3 } from './mat4';

// Activation conditions (runtime triggers).
export const ALWAYS = 'always';
export const IMAGE_LOADED = 'image_loaded';
export const ATLAS_REGISTERED = 'atlas_registered';
export const FRAME_LOCATED = 'frame_located';
export const TRANSDUCER_ADDED = 'transducer_added';
export const LANDMARKS_SELECTED = 'landmarks_selected';
export const TRAJECTORY_ADDED = 'trajectory_added';

export interface AxisOption {
  label: string;
  sign: number; // +1 keeps native value, -1 flips it (and the label)
}

export interface AxisSpec {
  options: AxisOption[]; // one = static label, several = a direction dropdown
}

export interface CoordSystem {
  id: string;
  name: string;
  condition: string;
  ref: string | null;
  space: Space | 'world' | null;
  axes: AxisSpec[];
  allowed: boolean;
  selected: boolean;
}

const OPPOSITE: Record<string, string> = {
  Left: 'Right',
  Right: 'Left',
  Posterior: 'Anterior',
  Anterior: 'Posterior',
  Superior: 'Inferior',
  Inferior: 'Superior',
};

const staticAxes = (labels: string[]): AxisSpec[] =>
  labels.map((l) => ({ options: [{ label: l, sign: 1 }] }));

const flipAxes = (labels: string[]): AxisSpec[] =>
  labels.map((l) => ({
    options: [
      { label: l, sign: 1 },
      { label: OPPOSITE[l], sign: -1 },
    ],
  }));

const RPI = ['Right', 'Posterior', 'Inferior'];
const RAS = ['Right', 'Anterior', 'Superior'];
const LPS = ['Left', 'Posterior', 'Superior'];
const CRS = ['Column', 'Row', 'Slice'];

function sys(
  id: string,
  name: string,
  condition: string,
  ref: string | null,
  space: Space | 'world' | null,
  axes: AxisSpec[],
  selected = false,
): CoordSystem {
  return { id, name, condition, ref, space, axes, allowed: true, selected };
}

// Order matches the desktop dropdown order.
export const COORD_SYSTEMS: CoordSystem[] = [
  sys('CT_PATIENT', 'CT Patient', ALWAYS, 'primary', 'patient', staticAxes(RPI), true),
  sys('FRAME', 'Frame', FRAME_LOCATED, 'frame', null, staticAxes(['Lateral', 'A-P', 'Vertical'])),
  sys('US', 'US', TRANSDUCER_ADDED, 'transducer', null, staticAxes(['X', 'Y', 'Z'])),
  sys('CT_MC', 'MC', LANDMARKS_SELECTED, 'primary', null, flipAxes(LPS)),
  sys('CT_AC', 'AC', LANDMARKS_SELECTED, 'primary', null, flipAxes(LPS)),
  sys('CT_PC', 'PC', LANDMARKS_SELECTED, 'primary', null, flipAxes(LPS)),
  sys('TRAJ', 'Trajectory', TRAJECTORY_ADDED, 'trajectory', null, flipAxes(LPS)),
  sys('SCAN1_PATIENT', 'Scan1 Patient', IMAGE_LOADED, 'top', 'patient', staticAxes(RPI)),
  sys('SCAN1_M', 'Scan1 MM', IMAGE_LOADED, 'top', 'image_mm', staticAxes(CRS)),
  sys('SCAN1_P', 'Scan1 Pixels', IMAGE_LOADED, 'top', 'pixel', staticAxes(CRS)),
  sys('SCAN1_W', 'Scan1 World', IMAGE_LOADED, 'top', 'image_world', staticAxes(LPS)),
  sys('SCAN1_RAS', 'Scan1 RAS', IMAGE_LOADED, 'top', 'ras', staticAxes(RAS)),
  sys('SCAN1_TBL', 'Scan1 Table', IMAGE_LOADED, 'top', 'table', staticAxes(RAS)),
  sys('ATLAS_M', 'Atlas MM', ATLAS_REGISTERED, 'atlas', null, staticAxes(CRS)),
  sys('ATLAS_W', 'Atlas World', ATLAS_REGISTERED, 'atlas', null, staticAxes(LPS)),
  sys('ATLAS_MC', 'Atlas MC', ATLAS_REGISTERED, 'atlas', null, flipAxes(LPS)),
  sys('GLOBAL_WORLD', 'World', IMAGE_LOADED, 'world', 'world', staticAxes(LPS)),
];

export function visibleSystems(
  activeConditions: Iterable<string>,
  systems = COORD_SYSTEMS,
): CoordSystem[] {
  const active = new Set(activeConditions);
  return systems.filter((s) => s.allowed && active.has(s.condition));
}

function nativeToValue(system: CoordSystem, image: Image | null, crosshair: Vec3): Vec3 {
  if (system.space === null || system.space === 'world' || image === null) {
    return [crosshair[0], crosshair[1], crosshair[2]];
  }
  return image.worldTo(system.space as Space, crosshair);
}

/** Global-world crosshair -> the 3 displayed axis values for the chosen directions.
 *  `choices` = the selected option index per axis (0 for static axes). */
export function toValues(
  system: CoordSystem,
  image: Image | null,
  crosshair: Vec3,
  choices: [number, number, number],
): [number, number, number] {
  const native = nativeToValue(system, image, crosshair);
  return [0, 1, 2].map(
    (i) => native[i] * system.axes[i].options[choices[i]].sign,
  ) as [number, number, number];
}

/** Typed axis values -> a global-world point (inverse of toValues). */
export function fromValues(
  system: CoordSystem,
  image: Image | null,
  values: [number, number, number],
  choices: [number, number, number],
): Vec3 {
  const native = [0, 1, 2].map(
    (i) => values[i] * system.axes[i].options[choices[i]].sign,
  ) as Vec3;
  if (system.space === null || system.space === 'world' || image === null) {
    return native;
  }
  return image.worldFrom(system.space as Space, native);
}
