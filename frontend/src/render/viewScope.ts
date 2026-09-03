// A takeover panel's claim on the views — the web reading of the desktop's
// AppContext.enter_exclusive_panel / exit_exclusive_panel (appcontext.py, workflow.py) plus the
// snapshot/restore each such panel does by hand there.
//
// The desktop's panels each roll their own `_saved` tuple: ValidationPanel saves
// (top, bottom, orientation, zoom, crosshair) + structure visibilities + six checkbox states,
// AdjustSegPanel saves a different set, SyntheticPreopPanel saves none. Three panels, three
// hand-written save/restore pairs — and all three forgot the per-pane pan and the 3D camera, so
// cancelling one of them leaves the views subtly moved.
//
// So the rule here is:
//
//     SNAPSHOT BROADLY, MUTATE NORMALLY, RESTORE WHOLESALE.
//
// This captures the union of what any takeover panel touches. A panel then just calls ordinary
// controller setters and declares/saves NOTHING, so a panel author cannot forget a field. Four
// panels are expected to use it (validation, adjust-seg, pick-seeds, erase-implant review).
//
// It is not a React context: everything worth saving lives on imperative objects (Scene, the
// ReslicePanes, View3D, the controller's own flags) outside React's tree, and a context would
// drop the snapshot on any remount. React only needs to know WHICH scope is open, and
// useControllerTick already delivers that from the controller's emit().
import type { Image } from '../core/image';
import type { ViewName } from '../core/scene';
import type { Vec3 } from '../core/mat4';
import type { Structure } from '../core/structure';
import type { Mode3D } from './View3D';
import type { Tool2D } from './ReslicePane';
import type { MeshMode2D, ViewerController } from './viewerController';

export type ScopeName = 'validate' | 'adjust-seg' | 'pick-seeds' | 'erase-review';

/** How often a scope pings the backend to keep the workspace hold alive. The hold lapses after
 *  HOLD_IDLE_SECONDS = 180 (backend/workflow.py) and a human review is minutes of zero HTTP
 *  traffic, so without this the workspace reads as free mid-review and someone can take it. */
const HEARTBEAT_MS = 60_000;

interface Camera3d {
  position: Vec3;
  focal: Vec3;
  viewUp: Vec3;
  parallelScale: number;
}

interface Snapshot {
  top: Image | null;
  bottom: Image | null;
  orientationMode: 'original' | 'primary';
  zoom: number;
  fovMm: number;
  crosshair: Vec3;
  paneCenters: Map<ViewName, Vec3>;
  camera3d: Camera3d | null;
  mode3d: Mode3D;
  projection3d: 'parallel' | 'perspective';
  meshMode2d: MeshMode2D;
  tool: Tool2D;
  trajectoriesVisible: boolean;
  leadsVisible: boolean;
  abVisible: boolean;
  guidanceOn: boolean;
  electrodePanelOn: boolean;
  structures: Map<string, { visible: boolean; visible2d: boolean }>;
}

export class ViewScope {
  /** Suppress loadCdb's re-framing while the panel owns the view. A pipeline result lands on
   *  every SSE revision and would otherwise reset the fov, the crosshair and the pan mid-review. */
  freezeFraming = true;
  /** Which bottom-dock tab the panel wants in front (ElectrodeDock reads this). */
  dockTab: string | null = null;

  /** Panel-driven structure visibility, re-applied after any structure-list rebuild:
   *  makePlanStructure re-derives `visible` from the plan object, so a mid-review revision
   *  would silently un-hide whatever the panel hid. */
  private overrides = new Map<string, boolean>();
  private snap: Snapshot;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  readonly name: ScopeName;
  private c: ViewerController;
  private onHeartbeat: (() => void) | null;

  constructor(name: ScopeName, c: ViewerController, onHeartbeat: (() => void) | null = null) {
    this.name = name;
    this.c = c;
    this.onHeartbeat = onHeartbeat;
    this.snap = this.take();
  }

  private take(): Snapshot {
    const v = this.c.scene.view;
    const paneCenters = new Map<ViewName, Vec3>();
    for (const p of this.c.panes) paneCenters.set(p.view, [...p.center] as Vec3);
    return {
      top: this.c.scene.top,
      bottom: this.c.scene.bottom,
      orientationMode: this.c.orientationMode,
      zoom: v.zoom,
      fovMm: v.fovMm,
      crosshair: [...(v.crosshair as Vec3)] as Vec3,
      paneCenters,
      camera3d: this.c.view3d?.cameraState() ?? null,
      mode3d: this.c.mode3d,
      projection3d: this.c.projection3d,
      meshMode2d: this.c.meshMode2d,
      tool: this.c.tool,
      trajectoriesVisible: this.c.trajectoriesVisible,
      leadsVisible: this.c.leadsVisible,
      abVisible: this.c.abVisible,
      guidanceOn: this.c.guidanceOn,
      electrodePanelOn: this.c.electrodePanelOn,
      structures: new Map(
        this.c.structures.map((s) => [s.id, { visible: s.visible, visible2d: s.visible2d }]),
      ),
    };
  }

  /** Claim the views.
   *
   *  Mutates nothing outside its own snapshot's coverage, which is what makes it safe under
   *  React StrictMode: the mount effect runs snapshot -> restore -> snapshot, and that only
   *  round-trips if entering is inert. A panel's own scene setup must therefore live in a
   *  SEPARATE effect after this one, so the second snapshot is taken against restored state
   *  rather than against the panel's first step. */
  enter(): void {
    if (this.c.view3d) this.c.view3d.autoFrame = false;
    if (this.onHeartbeat) this.heartbeat = setInterval(this.onHeartbeat, HEARTBEAT_MS);
  }

  /** Put everything back. The order is load-bearing and follows ValidationPanel._restore. */
  exit(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const s = this.snap;

    // selectTop clears the bottom slot, so the bottom has to go back second.
    if (s.top) this.c.selectTop(s.top);
    if (s.bottom) this.c.selectBottom(s.bottom);

    for (const [id, vis] of s.structures) this.c.updateStructure(id, vis);
    this.overrides.clear();

    this.c.setTrajectoriesVisible(s.trajectoriesVisible);
    this.c.setLeadsVisible(s.leadsVisible);
    this.c.setAbVisible(s.abVisible);
    this.c.setGuidanceVisible(s.guidanceOn);
    this.c.setElectrodePanel(s.electrodePanelOn);
    this.c.set3dMode(s.mode3d);
    this.c.set3dProjection(s.projection3d);
    this.c.setMeshMode2d(s.meshMode2d);
    this.c.setTool(s.tool);

    this.c.scene.view.zoom = s.zoom;
    this.c.scene.view.fovMm = s.fovMm;
    this.c.setOrientationMode(s.orientationMode); // re-derives the matrix from the restored top
    this.c.moveCrosshairTo(s.crosshair);

    // AFTER moveCrosshairTo: that recentres every pane on the crosshair, which would overwrite
    // the pan we are restoring. (The desktop drops the pan here — this is the one place the web
    // is deliberately better than its model.)
    for (const p of this.c.panes) {
      const centre = s.paneCenters.get(p.view);
      if (centre) p.center = [...centre] as Vec3;
    }

    if (this.c.view3d) {
      this.c.view3d.autoFrame = true;
      if (s.camera3d) this.c.view3d.setCameraState(s.camera3d);
    }
    this.c.refresh();
  }

  /** Record a panel-driven visibility change so a structure-list rebuild can re-apply it. */
  noteVisibility(id: string, visible: boolean): void {
    this.overrides.set(id, visible);
  }

  /** Re-apply the panel's visibility choices to a freshly built structure list. */
  reapplyOverrides(structures: Structure[]): void {
    for (const s of structures) {
      const want = this.overrides.get(s.id);
      if (want === undefined) continue;
      s.visible = want;
      if (s.origin === 'plan-structure') s.visible2d = want;
    }
  }
}
