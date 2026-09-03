// The preop-plan trajectory geometry for the 3D pane: the insertion line and CIP's surgical
// guidance accessories (IDL _DrawTraj / _DrawTrajAccessaries, ported from
// four_up_viewer._update_3d_trajectories + _build_traj_accessories + _clock_actors).
//
// Everything here is in GLOBAL WORLD — the backend already mapped the plan out of its source
// image's frame, and the web 3D view renders world directly (unlike the desktop, whose 3D pane
// lives in the top image's physical frame and needs world_to_scene).
//
// Text is NOT geometry here: vtk.js has neither vtkVectorText nor a billboard text actor, so
// labels come back as world anchors and View3D draws them on a 2D canvas over the pane. The
// clock dial (ring + hour ticks + hour numbers) is drawn once into a canvas and mapped onto a
// quad in the dial's plane — like the desktop's in-plane vector text, it reads correctly from
// the front and mirrored from behind, which is the cue that you are looking at the wrong side.

import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkPlaneSource from '@kitware/vtk.js/Filters/Sources/PlaneSource';
import vtkTexture from '@kitware/vtk.js/Rendering/Core/Texture';

import type { Vec3 } from '../core/mat4';
import { vadd, vcross, vnorm, vscale, vsub } from '../core/mat4';
import { GUIDANCE_POINTS, trajDisplayLine, type PlanTrajectory } from '../core/planObjects';

const CLOCK_RADIUS = 3.0; // mm — guidance clock-dial radius (IDL r=3, desktop _CLOCK_RADIUS)
const BLACK: Vec3 = [0, 0, 0];
const DARK: Vec3 = [0.1, 0.1, 0.1];
const RED: Vec3 = [1, 0, 0];
const BLUE: Vec3 = [0, 0, 1];
const CURL_HAND: Vec3 = [1, 0.2, 0.2];
const RW_HAND: Vec3 = [1, 0.85, 0.1];
const AB_YELLOW: Vec3 = [1, 1, 0];

/** A text label anchored at a world point; View3D projects and draws these. */
export interface Label3D {
  text: string;
  pos: Vec3;
  color: Vec3;
  /** Halo behind the text. Defaults to white, which suits the dark trajectory labels; the
   *  contact numbers are white themselves (the desktop's billboard) and want a dark one. */
  halo?: string;
}

export interface TrajectoryScene {
  actors: vtkActor[];
  labels: Label3D[];
}

export interface TrajectoryOpts {
  guidance: boolean; // clock dials, footplate lines, RW normal, anchors, point names
  annotation: boolean; // name labels (the desktop's global Annotation toggle)
}

/** All the 3D props for the trajectories currently drawn. The carrier coil and the track
 *  cylinder are NOT built here — they arrive from the backend as meshes and ride the normal
 *  structure path (core/structure.ts::makeTrajMesh). */
export function buildTrajectoryScene(trajs: PlanTrajectory[], opts: TrajectoryOpts): TrajectoryScene {
  const actors: vtkActor[] = [];
  const labels: Label3D[] = [];
  for (const t of trajs) {
    const line = trajDisplayLine(t);
    if (!line) continue;
    const [p0, p1] = line;
    actors.push(lineActor(p0, p1, t.color, 3));
    if (opts.annotation && t.name) labels.push({ text: t.name, pos: p1, color: t.color });
    if (opts.guidance) accessories(t, actors, labels, opts.annotation);
  }
  return { actors, labels };
}

/** IDL _DrawTrajAccessaries for one trajectory, driven off its 10 CIP guidance points. */
function accessories(t: PlanTrajectory, actors: vtkActor[], labels: Label3D[], annotation: boolean): void {
  const cip = t.extra?.cip;
  const pts = cip?.points;
  if (!pts || pts.length < 10 || !t.entry) return;
  const p = pts.map((q) => [q[0], q[1], q[2]] as Vec3);
  const P = GUIDANCE_POINTS;
  const entry = t.entry as Vec3;

  // curl clock: centre p0, 12:00 = footplate p2, normal p1, hand = curl direction p3
  actors.push(...clockActors(p[P.curlCenter], p[P.curlFootplate], p[P.curlNormal], p[P.curlHand], CURL_HAND));
  // round-window clock: centre p4, 12:00 = footplate p6, normal p5, hand = insertion dir p7
  actors.push(...clockActors(p[P.rwCenter], p[P.rwFootplate], p[P.rwNormal], p[P.rwHand], RW_HAND));

  actors.push(lineActor(p[P.curlCenter], p[P.curlFootplate], BLACK, 2)); // curl stapes-footplate
  actors.push(lineActor(p[P.rwCenter], p[P.rwFootplate], BLACK, 2)); // RW stapes-footplate
  actors.push(dashedLineActor(p[P.curlFootplate], p[P.rwFootplate], BLACK, 1)); // footplate dir

  // RW plane normal, drawn from the insertion entry
  const rwNormalEnd = vadd(entry, vscale(vsub(p[P.rwPlaneNormal], p[P.rwCenter]), 4.0));
  actors.push(lineActor(entry, rwNormalEnd, BLUE, 1));

  actors.push(sphereActor(p[P.rwCenter], RED, 0.1));
  actors.push(sphereActor(entry, RED, 0.15));
  actors.push(sphereActor(p[P.stapesFootplate], RED, 0.1));

  if (annotation) {
    const named: [string, Vec3][] = [
      ['Curl Direction', p[P.curlHand]],
      ['RW Insertion Direction', p[P.rwHand]],
      ['RW Normal', rwNormalEnd],
      ['RW Center', p[P.rwCenter]],
      ['Insertion Entry', entry],
      ['Center of Stapes Footplate', p[P.stapesFootplate]],
    ];
    for (const [text, pos] of named) labels.push({ text, pos, color: DARK });
  }
}

/** The scala-tympani A/B width measures: thick yellow segments (desktop _segment_actor). */
export function buildAbActors(segments: [Vec3, Vec3][]): vtkActor[] {
  return segments.map(([a, b]) => lineActor(a, b, AB_YELLOW, 2));
}

const MARKER_YELLOW: Vec3 = [1, 1, 0]; // _lead_marker_list's contact colour
const MARKER_SELECTED: Vec3 = [1, 0.25, 0.25];
const MARKER_RADIUS = 0.15; // mm — four_up_viewer.set_leads' marker_radius

/** Electrode contacts in 3D: a small sphere each, connected in order — the desktop's marker layer
 *  (four_up_viewer.set_leads: yellow spheres + a connecting polyline). */
export function buildMarkerActors(markers: { position: Vec3; selected: boolean }[]): vtkActor[] {
  if (!markers.length) return [];
  const out = markers.map((m) =>
    sphereActor(m.position, m.selected ? MARKER_SELECTED : MARKER_YELLOW, m.selected ? MARKER_RADIUS * 2 : MARKER_RADIUS),
  );
  const segs: [Vec3, Vec3][] = [];
  for (let i = 1; i < markers.length; i++) segs.push([markers[i - 1].position, markers[i].position]);
  // Solid in 3D — only the 2D layer dots it (_marker_connect_actor, line width 1.5).
  if (segs.length) out.push(polylineActor(segs, MARKER_YELLOW, 1.5));
  return out;
}

// --- primitives ------------------------------------------------------------------------

function polylineActor(segs: [Vec3, Vec3][], color: Vec3, width: number): vtkActor {
  const pd = vtkPolyData.newInstance();
  const pts = new Float32Array(segs.length * 6);
  const conn = new Uint32Array(segs.length * 3); // [2, i, j, 2, ...]
  segs.forEach(([a, b], k) => {
    pts.set(a, k * 6);
    pts.set(b, k * 6 + 3);
    conn[k * 3] = 2;
    conn[k * 3 + 1] = k * 2;
    conn[k * 3 + 2] = k * 2 + 1;
  });
  const points = vtkPoints.newInstance();
  points.setData(pts, 3);
  pd.setPoints(points);
  const lines = vtkCellArray.newInstance();
  lines.setData(conn);
  pd.setLines(lines);

  const mapper = vtkMapper.newInstance();
  mapper.setInputData(pd);
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setColor(color[0], color[1], color[2]);
  actor.getProperty().setLineWidth(width);
  actor.getProperty().setLighting(false);
  actor.setPickable(false);
  return actor;
}

function lineActor(p0: Vec3, p1: Vec3, color: Vec3, width: number): vtkActor {
  return polylineActor([[p0, p1]], color, width);
}

/** A dotted line built as short dashes — WebGL has no line stipple (IDL LINESTYLE=1). */
function dashedLineActor(p0: Vec3, p1: Vec3, color: Vec3, width: number, dash = 0.6, gap = 0.4): vtkActor {
  const d = vsub(p1, p0);
  const length = vnorm(d);
  if (length < 1e-6) return lineActor(p0, p1, color, width);
  const u = vscale(d, 1 / length);
  const segs: [Vec3, Vec3][] = [];
  for (let s = 0; s < length; s += dash + gap) {
    segs.push([vadd(p0, vscale(u, s)), vadd(p0, vscale(u, Math.min(s + dash, length)))]);
  }
  return polylineActor(segs, color, width);
}

function sphereActor(center: Vec3, color: Vec3, radius: number): vtkActor {
  const src = vtkSphereSource.newInstance({
    center: [center[0], center[1], center[2]],
    radius,
    thetaResolution: 12,
    phiResolution: 12,
  });
  const mapper = vtkMapper.newInstance();
  mapper.setInputConnection(src.getOutputPort());
  mapper.setScalarVisibility(false);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setColor(color[0], color[1], color[2]);
  actor.setPickable(false);
  return actor;
}

// --- clock dial ------------------------------------------------------------------------

/** A clock dial at `center`: the textured face (ring + hour ticks + hour numbers, 12 toward
 *  `upPt`, numbers clockwise) in the plane whose normal points at `normalPt`, plus a coloured
 *  hand toward `handPt`. Port of four_up_viewer._clock_actors. */
function clockActors(center: Vec3, upPt: Vec3, normalPt: Vec3, handPt: Vec3, handColor: Vec3): vtkActor[] {
  let y = vsub(upPt, center);
  let z = vsub(normalPt, center);
  const ny = vnorm(y);
  const nz = vnorm(z);
  if (ny < 1e-6 || nz < 1e-6) return [];
  y = vscale(y, 1 / ny);
  z = vscale(z, 1 / nz);
  let x = vcross(y, z);
  const nx = vnorm(x);
  if (nx < 1e-6) return [];
  x = vscale(x, 1 / nx);

  const r = CLOCK_RADIUS;
  const half = r * FACE_MARGIN;
  // The quad's texture runs u along +x and v along +y; the canvas is uploaded flipped
  // (UNPACK_FLIP_Y_WEBGL), so the canvas's TOP row lands at v=1, i.e. toward +y = 12 o'clock.
  const plane = vtkPlaneSource.newInstance({
    origin: vadd(center, vadd(vscale(x, -half), vscale(y, -half))),
    point1: vadd(center, vadd(vscale(x, half), vscale(y, -half))),
    point2: vadd(center, vadd(vscale(x, -half), vscale(y, half))),
    xResolution: 1,
    yResolution: 1,
  });
  const mapper = vtkMapper.newInstance();
  mapper.setInputConnection(plane.getOutputPort());
  mapper.setScalarVisibility(false);
  const face = vtkActor.newInstance();
  face.setMapper(mapper);
  face.getProperty().setLighting(false);
  face.getProperty().setBackfaceCulling(false);
  face.setPickable(false);
  const texture = vtkTexture.newInstance();
  texture.setInterpolate(true);
  // setCanvas exists on vtkTexture but is missing from its .d.ts (vtk.js 3x).
  (texture as unknown as { setCanvas(c: HTMLCanvasElement): void }).setCanvas(dialCanvas());
  face.addTexture(texture);

  const actors = [face];
  const hand = vsub(handPt, center);
  const hl = vnorm(hand);
  if (hl > 1e-6) {
    actors.push(lineActor(center, vadd(center, vscale(hand, (r * 1.15) / hl)), handColor, 3));
  }
  return actors;
}

const FACE_MARGIN = 1.05; // the quad is slightly larger than r so the ring stroke fits
const DIAL_PX = 512;
let dialCache: HTMLCanvasElement | null = null;

/** The dial face, drawn once and shared by every dial (they differ only in placement).
 *  Transparent outside the ring so the anatomy behind shows through. */
function dialCanvas(): HTMLCanvasElement {
  if (dialCache) return dialCache;
  const cvs = document.createElement('canvas');
  cvs.width = DIAL_PX;
  cvs.height = DIAL_PX;
  const g = cvs.getContext('2d')!;
  const c = DIAL_PX / 2;
  const R = c / FACE_MARGIN; // the world radius r, in px
  g.clearRect(0, 0, DIAL_PX, DIAL_PX);
  g.strokeStyle = '#1a1a1a';
  g.fillStyle = '#1a1a1a';
  g.lineWidth = DIAL_PX / 200;

  g.beginPath();
  g.arc(c, c, R, 0, 2 * Math.PI);
  g.stroke();

  // Hour ticks (r -> 0.88r) and numbers (0.74r), 12 at the top, running clockwise. Canvas y is
  // down while the world +y is up, so the sine term is negated.
  g.font = `${Math.round(0.55 * (R / CLOCK_RADIUS))}px sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let h = 0; h < 12; h++) {
    const th = ((90 - 30 * h) * Math.PI) / 180;
    const dx = Math.cos(th);
    const dy = -Math.sin(th);
    g.beginPath();
    g.moveTo(c + R * dx, c + R * dy);
    g.lineTo(c + 0.88 * R * dx, c + 0.88 * R * dy);
    g.stroke();
    const label = h === 0 ? 12 : h;
    g.fillText(String(label), c + 0.74 * R * dx, c + 0.74 * R * dy);
  }
  dialCache = cvs;
  return cvs;
}
