// REST client for the WebCIP backend (the one-time file decoder). All rendering is
// client-side; these calls only fetch decoded pixels + geometry.

import type { PlanSession } from '../core/planObjects';
import { API } from './paths';

// Follows the mount point, so the same build talks to /api locally and /webcip/api in prod.
const BASE = API;

export interface Patient {
  id: string;
  name: string;
  dob: string;
  sex: string;
  institution: string;
}

// Geometry + display defaults the TS core needs to reconstruct a pv_core Image.
export interface VolumeMeta {
  id: string;
  name: string;
  size: [number, number, number]; // x, y, z
  spacing: [number, number, number];
  center_index: [number, number, number];
  center_phys: [number, number, number];
  origin_phys: [number, number, number];
  direction: number[]; // snapped 3x3 row-major (9)
  raw_direction: number[];
  // A .cdb's images are crops declaring their FULL geometry: `size` is the stored crop while
  // center_index/direction describe the full grid, and `crop_origin` is the crop's first voxel in
  // it. [0,0,0] for a normal image.
  full_size: [number, number, number];
  crop_origin: [number, number, number];
  world_matrix: number[]; // 4x4 row-major, global-world -> image-world
  role: string; // workflow slot: preop / postop / synthetic; '' = a plain scan
  orientation_label: string;
  value_min: number;
  value_max: number;
  level: number;
  window: number;
  header_level: number | null;
  header_window: number | null;
  dtype: string; // e.g. "Int16" -> Int16Array
  scalar_size_bytes: number;
  // Per-image display state (pv_core/image.py). Defaults for a freshly loaded file; the
  // values a plan saved for the image when it comes from POST /plan.
  interp: 'linear' | 'nearest';
  colormap_index: number;
  crop_box: number[] | null;
  show_cropped: boolean;
  fg_window: [number, number];
  surface_threshold: [number, number];
  surface_style: string;
  render3d_mode: string;
  patient: Patient;
}

export interface HeaderTable {
  type: string;
  columns: string[];
  rows: string[][];
}

export interface BrowseEntry {
  name: string;
  path: string;
  dir: boolean;
  /** 'run' for a pipeline output folder, 'case' for a result folder, '' otherwise. */
  kind?: string;
  size?: number;
}

export interface BrowseResult {
  path: string;
  parent: string;
  roots: string[];
  entries: BrowseEntry[];
}

// TypedArrays that can back a vtkImageData scalar buffer (all have length + numeric indexing).
export type NumericArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

const TYPED: Record<string, new (b: ArrayBuffer) => NumericArray> = {
  Int8: Int8Array,
  Uint8: Uint8Array,
  Int16: Int16Array,
  Uint16: Uint16Array,
  Int32: Int32Array,
  Uint32: Uint32Array,
  Float32: Float32Array,
  Float64: Float64Array,
};

/** A refusal that carries structured data — today only the 409 from the workspace hold, whose
 *  detail names the holder so the UI can offer "Take over" (backend/hold.py). */
export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/** True when a call was refused because another browser holds the workspace. */
export const isHeldError = (e: unknown) =>
  e instanceof ApiError && e.status === 409 && !!(e.detail as { canTakeOver?: boolean })?.canTakeOver;

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = body?.detail;
    // FastAPI's detail is usually a string; the hold conflict sends an object.
    const message =
      typeof detail === 'string'
        ? detail
        : (detail?.message ?? res.statusText);
    throw new ApiError(message, res.status, detail);
  }
  return res.json() as Promise<T>;
}

/** This server's filesystem defaults for the load boxes (backend/routes/config.py).
 *  The paths differ per host, so they are fetched rather than baked into the bundle. */
export interface ServerConfig {
  dataRoot: string;
  defaults: { image: string; plan: string; cdb: string; case: string };
}

export async function fetchConfig(): Promise<ServerConfig> {
  return j(await fetch(`${BASE}/config`));
}

/** Everything under the server's data roots that can be opened WITHOUT running the pipeline:
 *  finished case folders, saved plans, postop data blocks. Lets the load controls offer a list
 *  instead of asking for a remembered path. */
export interface OpenableItem {
  name: string;
  path: string;
}

export interface Openable {
  roots: string[];
  cases: OpenableItem[];
  plans: OpenableItem[];
  cdbs: OpenableItem[];
  /** Past pipeline runs, newest first — reopened from their output folders. */
  jobs: OpenableItem[];
}

export async function fetchOpenable(): Promise<Openable> {
  return j(await fetch(`${BASE}/openable`));
}

/** Rebuild a past pipeline run from its output folder. Comes back in POST /cdb's shape, so it
 *  displays through the same path — structures, lead, electrode dock. */
export async function loadJobFolder(folder: string): Promise<CdbData> {
  return post(`${BASE}/job`, { folder });
}

/** `role` is the workflow slot ('preop' / 'postop'); '' is a plain scan. The processing steps
 *  key off it, so it is chosen at load time. */
export async function loadPath(path: string, name?: string, role = ''): Promise<VolumeMeta> {
  return j(
    await fetch(`${BASE}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name, role }),
    }),
  );
}

/** Uploads are stored server-side as `<case>_<role>.<ext>`, flat and overwriting: re-uploading
 *  the same case + role REPLACES the file instead of accumulating copies. `case` is required. */
export async function uploadFile(file: File, role = '', caseName = ''): Promise<VolumeMeta> {
  const form = new FormData();
  form.append('file', file);
  form.append('role', role);
  form.append('case', caseName);
  return j(await fetch(`${BASE}/upload`, { method: 'POST', body: form }));
}

/** Change a loaded image's workflow slot. The BACKEND store is what the processing steps read,
 *  so this must round-trip to the server, not just update the browser's copy. */
export async function setImageRole(id: string, role: string): Promise<VolumeMeta> {
  return j(
    await fetch(`${BASE}/images/${id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }),
  );
}

// Fetch the raw pixel buffer and wrap it in the right TypedArray for VTK.js.
export async function fetchVolume(
  id: string,
): Promise<{ pixels: NumericArray; dtype: string; dims: [number, number, number] }> {
  const res = await fetch(`${BASE}/volume/${id}`);
  if (!res.ok) throw new Error(`volume ${id}: ${res.status}`);
  const dtype = res.headers.get('X-Dtype') ?? 'Int16';
  const dims = (res.headers.get('X-Dims') ?? '0,0,0')
    .split(',')
    .map(Number) as [number, number, number];
  const buf = await res.arrayBuffer();
  const Ctor = TYPED[dtype] ?? Int16Array;
  return { pixels: new Ctor(buf), dtype, dims };
}

export async function fetchHeader(id: string): Promise<HeaderTable> {
  return j(await fetch(`${BASE}/header/${id}`));
}

/** One directory on the SERVER, for the file picker. `kind` selects the extension filter. */
export async function browse(path: string, kind = 'image'): Promise<BrowseResult> {
  const q = new URLSearchParams({ path, kind });
  return j(await fetch(`${BASE}/browse?${q}`));
}

/** Store an uploaded file and get back its path on the server — no decoding, no session change.
 *  Lets the picker's upload button end where browsing ends. */
export async function uploadAnyFile(file: File): Promise<{ path: string; name: string }> {
  const form = new FormData();
  form.append('file', file);
  return j(await fetch(`${BASE}/upload-file`, { method: 'POST', body: form }));
}

export async function fetchColormapNames(): Promise<string[]> {
  const r = await j<{ names: string[] }>(await fetch(`${BASE}/colormaps`));
  return r.names;
}

export async function fetchColormap(index: number): Promise<number[][]> {
  const r = await j<{ rgb: number[][] }>(await fetch(`${BASE}/colormap/${index}`));
  return r.rgb; // 256 x 3
}

export interface SurfaceMesh {
  points: Float32Array; // n*3, global-world coords
  normals: Float32Array; // n*3
  tris: Uint32Array; // ntri*3 vertex indices
}

function parseMeshBlob(buf: ArrayBuffer, nPts: number, nTris: number): SurfaceMesh {
  const points = new Float32Array(buf, 0, nPts * 3);
  const normals = new Float32Array(buf, nPts * 3 * 4, nPts * 3);
  const tris = new Uint32Array(buf, nPts * 3 * 4 * 2, nTris * 3);
  return { points, normals, tris };
}

// Isosurface mesh built server-side with C++ vtkFlyingEdges3D (desktop-speed).
export async function fetchSurface(id: string, iso?: number, cutoff?: number): Promise<SurfaceMesh> {
  const q = new URLSearchParams();
  if (iso != null) q.set('iso', String(iso));
  if (cutoff != null) q.set('cutoff', String(cutoff));
  const res = await fetch(`${BASE}/surface/${id}?${q}`);
  if (!res.ok) throw new Error(`surface ${id}: ${res.status}`);
  const nPts = Number(res.headers.get('X-NPoints') ?? 0);
  const nTris = Number(res.headers.get('X-NTris') ?? 0);
  return parseMeshBlob(await res.arrayBuffer(), nPts, nTris);
}

// --- result-display case API ----------------------------------------------
export interface MeshManifestItem {
  index: number;
  name: string;
  label: string;
  type_id: number;
  color: [number, number, number]; // 0-255
  opacity: number;
  render_order: number;
  n_points: number;
  n_tris: number;
}

export interface CaseMeta {
  structures: Record<string, { name: string; type_id: number; shape: [number, number] }>;
  structures_order: string[];
  implants_order: string[];
  fpoint: number[];
  sz: number[];
  orient: number[];
  image_size: number[];
  plan_id: string;
  side: string;
  type: string;
}

export interface CaseData {
  caseId: string;
  imageId: string;
  image: VolumeMeta;
  meta: CaseMeta;
  stats: Record<string, unknown>;
}

export async function loadCase(folder: string): Promise<CaseData> {
  return j(
    await fetch(`${BASE}/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    }),
  );
}

export async function fetchMeshManifest(
  caseId: string,
  group: 'structures' | 'implants',
): Promise<MeshManifestItem[]> {
  const r = await j<{ meshes: MeshManifestItem[] }>(await fetch(`${BASE}/case/${caseId}/meshes/${group}`));
  return r.meshes;
}

export async function fetchMesh(
  caseId: string,
  group: 'structures' | 'implants',
  index: number,
  nPts: number,
  nTris: number,
): Promise<SurfaceMesh> {
  const res = await fetch(`${BASE}/case/${caseId}/mesh/${group}/${index}`);
  if (!res.ok) throw new Error(`mesh ${group}/${index}: ${res.status}`);
  return parseMeshBlob(await res.arrayBuffer(), nPts, nTris);
}

// Electrode reconstruction data (curves.json) — per-electrode maps keyed by contact number.
export interface ElectrodeData {
  raw: Record<string, number[]>; // per-electrode 300-pt distance curve (vs curvefreqs)
  min_dist: Record<string, number>; // closest distance to modiolus (mm)
  angle: Record<string, number>; // insertion angle (°)
  min_freq: Record<string, number>; // place frequency, Patient (Hz)
  c_freq: Record<string, number>; // channel frequency, Manufacturer (Hz)
  location: Record<string, string>; // scala label per electrode
  base: number;
  electrode_type: number;
  curvefreqs: number[]; // 300 frequencies (x-axis for the curves chart)
}

export async function fetchCurves(caseId: string): Promise<ElectrodeData> {
  return j(await fetch(`${BASE}/case/${caseId}/curves`));
}

// --- preop plan (.pws / .pwi workspace) -------------------------------------
// The backend parses the file with pv_core.workspace and hands back the restored images,
// the planning session (geometry already in global world) and a manifest of mesh blobs.

/** Saved view state (pv_core/workspace.py::view_record). */
export interface PlanView {
  crosshair: [number, number, number];
  slice_step: number;
  zoom: number;
  blend_alpha: number;
  fov_mm: number;
  radiological: boolean;
  /** The desktop's one-shot auto-zoom, {kind: zoom} — armed when a plan loads and consumed by
   *  the first mesh / electrode click (four_up_viewer._consume_default_zoom). Sent by the
   *  backend and deliberately IGNORED here: the web frames from the call site instead
   *  (ViewerController.centerOn takes an explicit zoom), so there is no click-triggered state
   *  to keep. Typed so the field is a documented no-op rather than a silent drop. */
  default_zoom?: Record<string, number> | null;
}

/** Saved shell/panel state (the workspace 'ui' block; desktop main.py owns its shape). */
export interface PlanUi {
  maximized?: string | null;
  pan2d?: Record<string, [number, number, number] | null>; // keyed "Coronal"/"Sagittal"/"Axial"
  camera3d?: {
    position: [number, number, number];
    focal: [number, number, number];
    view_up: [number, number, number];
    parallel_scale: number;
    view_angle: number;
  } | null;
  display?: {
    reference_line?: boolean;
    mesh_mode?: string; // none | contour | transparent | solid
    magnifier?: number;
    projection3d?: 'parallel' | 'perspective';
    image3d_visible?: boolean;
    annotation?: boolean;
    point_projection?: boolean;
  };
  coordinates?: { frame?: string; update?: boolean };
}

/** One mesh blob in the plan: `struct:<id>` | `carrier:<trajId>` | `track:<trajId>`. */
export interface PlanMeshRef {
  key: string;
  n_points: number;
  n_tris: number;
}

export interface PlanData {
  planId: string;
  path: string;
  name: string;
  images: VolumeMeta[];
  top: string | null;
  bottom: string | null;
  view: PlanView;
  ui: PlanUi;
  session: PlanSession;
  meshes: PlanMeshRef[];
  skipped: { name: string; reason: string }[]; // images that could not be re-read
  warnings: string[]; // geometry differences vs what was saved
}

export async function loadPlan(path: string): Promise<PlanData> {
  return j(
    await fetch(`${BASE}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function fetchPlanMesh(planId: string, ref: PlanMeshRef): Promise<SurfaceMesh> {
  const res = await fetch(`${BASE}/plan/${planId}/mesh/${encodeURIComponent(ref.key)}`);
  if (!res.ok) throw new Error(`plan mesh ${ref.key}: ${res.status}`);
  return parseMeshBlob(await res.arrayBuffer(), ref.n_points, ref.n_tris);
}

// --- postop CDB (the plan's companion data block) ---------------------------
// Same shape as the plan API; the backend assembles it with projects.cip.cdb_scene.

/** One row of the electrode table (projects.cip.electrode.table_rows). null = not available. */
export interface ElectrodeRow {
  label: string;
  distance: number | null;
  angle: number | null;
  place_freq: number | null;
  channel_freq: number | null;
  scala: number | null;
}

/** Per-electrode arrays for the analysis charts (electrode.figure_series), contact-index order. */
export interface FigureSeries {
  number: number[];
  label: number[];
  place_freq: (number | null)[];
  channel_freq: (number | null)[];
  angle: (number | null)[];
  distance: (number | null)[];
}

export interface CdbElectrodes {
  rows: ElectrodeRow[];
  series: FigureSeries;
  settings: string[]; // activation setting names
  cur_setting: number;
  model: string;
  side: string;
  name: string;
  scala_names: Record<string, string>;
}

export interface CdbData {
  cdbId: string;
  path: string;
  name: string;
  side: number;
  sides: number[];
  images: VolumeMeta[];
  top: string | null;
  bottom: string | null;
  primary: string | null;
  session: PlanSession;
  meshes: PlanMeshRef[];
  electrodes: CdbElectrodes;
  warnings: string[];
}

/** Everything the interactive Curves graph needs (electrode.graph_series), contact-index order. */
export interface GraphSeries {
  angle: number[];
  angle_edited: boolean[];
  scala: number[];
  scala_edited: boolean[];
  deact_edited: boolean[];
  onoff: number[]; // 1 on / 0 off / -1 deactivated
  label: number[];
  valid: boolean[]; // false = an IDL placeholder slot
  dist_values: (number | null)[][]; // n x distCount, distance to the modiolar axis
  dist_cangles: number[]; // cochlear angle per distance sample
  dist_freq: number[]; // place frequency per distance sample
  cl_cangles: number[]; // centerline angles (the scrub slider's domain)
  cl_z: number[];
  cl_dist: number[];
  cl_coords: number[][];
  bid: number | null; // basal insertion depth (mm)
  bid_cells: number | null; // in electrode-pitch units, for the array marker
  basal_index: number | null;
}

export interface MipPoints {
  width: number;
  height: number;
  points: { label: number; x: number; y: number }[];
}

// --- auto process (the unattended CIP pipeline) -----------------------------
// A run takes minutes across four Docker tools, so start() only kicks it off and progress
// arrives over SSE. The finished run is served in CdbData's shape and is registered under its
// job id in the cdb registry, so the mesh / graph / mip fetchers above work on it unchanged.

export type AutoStatus = 'pending' | 'running' | 'done' | 'failed';

export interface AutoStep {
  key: string;
  label: string;
  status: AutoStatus;
  elapsed: number; // seconds
}

export interface AutoState {
  jobId: string;
  steps: AutoStep[];
  active: string | null;
  line: string; // the running tool's latest log line
  frac: number | null;
  total: number; // seconds
  /** Bumped when a step lands something displayable — refetch the result when it changes. */
  revision: number;
  error: string | null;
  finished: boolean;
  completed: boolean; // every step done
}

export interface ElectrodeOption {
  id: number;
  label: string;
}

export async function fetchElectrodeOptions(): Promise<ElectrodeOption[]> {
  return (await j<{ electrodes: ElectrodeOption[] }>(await fetch(`${BASE}/auto/electrodes`))).electrodes;
}

/** The workflow session: banner, loaded images with roles, per-step gating, and which results
 *  exist. Gating is computed server-side from the desktop's own `is_available` rules, so it is
 *  stated once rather than restated here. */
export interface WorkflowState {
  /** Opaque id of the browser holding the single shared workspace; '' when free. */
  holder: string;
  /** Unix seconds of that browser's last action. */
  holderSince: number;
  /** False when someone else holds it — the workflow column shows a banner. */
  isMine: boolean;
  /** True only while a step is actually running, anywhere. */
  busy: boolean;
  /** The running step's label, when busy. */
  busyLabel: string;
  side: string;
  module: string; // 'preop' | 'postop'
  planName: string;
  images: VolumeMeta[];
  electrodeId: number | null;
  results: {
    registered: boolean;
    structures: boolean;
    synthetic: boolean;
    postopRegistered: boolean;
    lead: boolean;
  };
  available: Record<string, boolean>;
}

export async function fetchWorkflow(): Promise<WorkflowState> {
  return j(await fetch(`${BASE}/workflow`));
}

export async function setWorkflowSide(side: string): Promise<WorkflowState> {
  return post(`${BASE}/workflow/side`, { side });
}

/** Hand the workspace back, rather than leaving others to wait out the idle timer. */
export async function releaseWorkflow(): Promise<WorkflowState> {
  return post(`${BASE}/workflow/release`, {});
}

/** Take the shared workspace from whoever holds it (the banner's "Take over"). */
export async function claimWorkflow(takeover = true): Promise<WorkflowState> {
  return post(`${BASE}/workflow/claim`, { takeover });
}

export const clearWorkspace = () => post<WorkflowState>(`${BASE}/workflow/clear`, {});
export const clearStructures = () => post<WorkflowState>(`${BASE}/workflow/clear-structures`, {});
export const clearElectrodes = () => post<WorkflowState>(`${BASE}/workflow/clear-electrodes`, {});

/** Run ONE numbered step. Same job machinery as Auto process, so progress and the result arrive
 *  through `watchAuto` / `fetchAutoResult` exactly as they do for a full run. */
export async function runStep(key: string, electrodeId?: number): Promise<AutoState> {
  return post(`${BASE}/step/${key}`, { electrodeId: electrodeId ?? null });
}

async function post<T>(url: string, body: unknown): Promise<T> {
  return j(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function startAuto(side: string, electrodeId: number): Promise<AutoState> {
  return post(`${BASE}/auto/start`, { side, electrodeId });
}

export async function fetchAutoState(jobId: string): Promise<AutoState> {
  return j(await fetch(`${BASE}/auto/${jobId}`));
}

/** Follow a run. Returns an unsubscribe; `onState` fires on every change and a few times a
 *  second while a step runs, so elapsed times stay live. */
export function watchAuto(jobId: string, onState: (s: AutoState) => void): () => void {
  const es = new EventSource(`${BASE}/auto/${jobId}/events`);
  es.onmessage = (e) => {
    const s = JSON.parse(e.data) as AutoState;
    onState(s);
    if (s.finished) es.close();
  };
  es.onerror = () => es.close();
  return () => es.close();
}

/** The run's CURRENT result, in CdbData's shape — valid after ANY completed step, so each
 *  step's output can be shown as it lands (the desktop pushes into its live scene). */
export async function fetchAutoResult(jobId: string): Promise<CdbData> {
  return j(await fetch(`${BASE}/auto/${jobId}/result`));
}

export async function loadCdb(path: string, side?: number): Promise<CdbData> {
  return j(
    await fetch(`${BASE}/cdb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, side: side ?? null }),
    }),
  );
}

export async function fetchCdbMesh(cdbId: string, ref: PlanMeshRef): Promise<SurfaceMesh> {
  const res = await fetch(`${BASE}/cdb/${cdbId}/mesh/${encodeURIComponent(ref.key)}`);
  if (!res.ok) throw new Error(`cdb mesh ${ref.key}: ${res.status}`);
  return parseMeshBlob(await res.arrayBuffer(), ref.n_points, ref.n_tris);
}

export async function fetchGraphSeries(cdbId: string, setting: number): Promise<GraphSeries> {
  return j(await fetch(`${BASE}/cdb/${cdbId}/graph?setting=${setting}`));
}

export const mipUrl = (cdbId: string) => `${BASE}/cdb/${cdbId}/mip`;

export async function fetchMipPoints(cdbId: string): Promise<MipPoints> {
  return j(await fetch(`${BASE}/cdb/${cdbId}/mip/points`));
}
