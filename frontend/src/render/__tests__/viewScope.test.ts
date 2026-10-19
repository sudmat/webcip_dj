import { describe, expect, it, vi } from 'vitest';
import { ViewScope } from '../viewScope';
import type { ViewerController } from '../viewerController';
import type { Structure } from '../../core/structure';
import type { Image } from '../../core/image';

// ViewScope only ever touches plain fields and controller methods, so a stand-in controller is
// enough to test the property that matters: whatever a panel does through ordinary setters, exit
// puts back. That property is what lets a takeover panel save nothing of its own.

const img = (id: string) => ({ id, role: '' }) as Image;

function struct(id: string, visible: boolean): Structure {
  return {
    id,
    group: 'structures',
    index: 0,
    origin: 'plan-structure',
    name: id,
    label: id,
    typeId: 0,
    color: [1, 1, 1],
    opacity: 1,
    renderOrder: 0,
    visible,
    visible2d: visible,
    mesh: { points: new Float32Array(), normals: new Float32Array(), tris: new Uint32Array() },
  };
}

/** A controller stand-in whose setters mutate the same fields the real one does. */
function fakeController(structures: Structure[]) {
  const top = img('top');
  const bottom = img('bottom');
  const camera = { position: [0, 0, 10], focal: [0, 0, 0], viewUp: [0, 1, 0], parallelScale: 128 };
  const c = {
    scene: {
      images: [top, bottom],
      top: top as Image | null,
      bottom: bottom as Image | null,
      view: { zoom: 1, fovMm: 256, crosshair: [1, 2, 3] as [number, number, number] },
      setCrosshair(p: [number, number, number]) {
        c.scene.view.crosshair = [...p] as [number, number, number];
      },
    },
    panes: [
      { view: 'axial', center: [1, 2, 3] as [number, number, number] },
      { view: 'coronal', center: [4, 5, 6] as [number, number, number] },
    ],
    view3d: {
      autoFrame: true,
      cameraState: () => ({ ...camera }),
      setCameraState: (s: typeof camera) => Object.assign(camera, s),
      centerOn: () => {},
    },
    camera,
    structures,
    orientationMode: 'primary' as 'original' | 'primary',
    mode3d: 'surface',
    projection3d: 'parallel',
    meshMode2d: 'contour',
    tool: 'position',
    trajectoriesVisible: true,
    leadsVisible: true,
    abVisible: true,
    guidanceOn: false,
    electrodePanelOn: true,
    refreshes: 0,

    selectTop(im: Image) {
      c.scene.top = im;
      c.scene.bottom = null; // the real one clears the bottom slot, which is why order matters
    },
    selectBottom(im: Image | null) {
      c.scene.bottom = im;
    },
    updateStructure(id: string, patch: Partial<Structure>) {
      const s = c.structures.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
    },
    setTrajectoriesVisible: (v: boolean) => void (c.trajectoriesVisible = v),
    setLeadsVisible: (v: boolean) => void (c.leadsVisible = v),
    setAbVisible: (v: boolean) => void (c.abVisible = v),
    setGuidanceVisible: (v: boolean) => void (c.guidanceOn = v),
    setElectrodePanel: (v: boolean) => void (c.electrodePanelOn = v),
    set3dMode: (v: string) => void (c.mode3d = v),
    set3dProjection: (v: string) => void (c.projection3d = v),
    setMeshMode2d: (v: string) => void (c.meshMode2d = v),
    setTool: (v: string) => void (c.tool = v),
    setOrientationMode: (v: 'original' | 'primary') => void (c.orientationMode = v),
    moveCrosshairTo(p: [number, number, number]) {
      c.scene.setCrosshair(p);
      for (const pane of c.panes) pane.center = [...p] as [number, number, number]; // recenterAll
    },
    refresh: () => void (c.refreshes += 1),
  };
  return c;
}

describe('ViewScope', () => {
  it('restores everything a panel changed', () => {
    const structures = [struct('a', true), struct('b', true)];
    const c = fakeController(structures);
    const scope = new ViewScope('validate', c as unknown as ViewerController);
    scope.enter();

    // What a panel typically does: take a slot, change the frame, hide things, reframe.
    c.selectTop(c.scene.images[1]);
    c.setOrientationMode('original');
    c.scene.view.zoom = 20;
    c.scene.view.fovMm = 45;
    c.moveCrosshairTo([9, 9, 9]);
    c.updateStructure('a', { visible: false });
    c.setLeadsVisible(false);
    c.setElectrodePanel(false);
    c.set3dMode('none');
    c.setTool('measure');
    c.camera.parallelScale = 6.4;

    scope.exit();

    expect(c.scene.top?.id).toBe('top');
    expect(c.scene.bottom?.id).toBe('bottom'); // restored AFTER top, which clears it
    expect(c.orientationMode).toBe('primary');
    expect(c.scene.view.zoom).toBe(1);
    expect(c.scene.view.fovMm).toBe(256);
    expect(c.scene.view.crosshair).toEqual([1, 2, 3]);
    expect(c.structures[0].visible).toBe(true);
    expect(c.leadsVisible).toBe(true);
    expect(c.electrodePanelOn).toBe(true);
    expect(c.mode3d).toBe('surface');
    expect(c.tool).toBe('position');
    expect(c.camera.parallelScale).toBe(128);
  });

  // The desktop's own panels drop these two — its _saved tuple has no pan and no camera, so
  // cancelling one leaves the views subtly moved. Restoring them is the point of the shared seam.
  it('restores the per-pane pan, after the crosshair move that would overwrite it', () => {
    const c = fakeController([]);
    const scope = new ViewScope('validate', c as unknown as ViewerController);
    scope.enter();
    c.moveCrosshairTo([9, 9, 9]); // stamps [9,9,9] into every pane's centre
    scope.exit();
    expect(c.panes[0].center).toEqual([1, 2, 3]);
    expect(c.panes[1].center).toEqual([4, 5, 6]); // its own pan, not the crosshair
  });

  // A panel finished normally (Done) keeps the framing the review established — the reviewer
  // spent three steps getting the views onto the anatomy. Only the SCENE goes back.
  it('keepView restores the scene but leaves the framing alone', () => {
    const c = fakeController([struct('a', true)]);
    const scope = new ViewScope('validate', c as unknown as ViewerController);
    scope.enter();

    c.selectTop(c.scene.images[1]);
    c.updateStructure('a', { visible: false });
    c.setLeadsVisible(false);
    c.scene.view.zoom = 20;
    c.moveCrosshairTo([9, 9, 9]);
    c.camera.parallelScale = 6.4;

    scope.exit(true);

    // scene: back
    expect(c.scene.top?.id).toBe('top');
    expect(c.scene.bottom?.id).toBe('bottom');
    expect(c.structures[0].visible).toBe(true);
    expect(c.leadsVisible).toBe(true);
    expect(c.orientationMode).toBe('primary'); // the frame is scene state, not framing
    // framing: kept
    expect(c.scene.view.zoom).toBe(20);
    expect(c.scene.view.crosshair).toEqual([9, 9, 9]);
    expect(c.panes[0].center).toEqual([9, 9, 9]);
    expect(c.camera.parallelScale).toBe(6.4);
    expect(c.view3d.autoFrame).toBe(true); // still re-armed, either way
  });

  it('hands the 3D camera back and re-arms auto-framing', () => {
    const c = fakeController([]);
    const scope = new ViewScope('validate', c as unknown as ViewerController);
    scope.enter();
    expect(c.view3d.autoFrame).toBe(false); // a panel owns the camera while it runs
    scope.exit();
    expect(c.view3d.autoFrame).toBe(true);
  });

  // A pipeline revision rebuilds the structure list with `visible` re-derived from the plan, so
  // without this a panel's hidden structures silently come back mid-review.
  it('re-applies a panel visibility override to a rebuilt structure list', () => {
    const c = fakeController([struct('a', true)]);
    const scope = new ViewScope('validate', c as unknown as ViewerController);
    scope.enter();
    scope.noteVisibility('a', false);

    const rebuilt = [struct('a', true), struct('new', true)];
    scope.reapplyOverrides(rebuilt);
    expect(rebuilt[0].visible).toBe(false);
    expect(rebuilt[0].visible2d).toBe(false); // a plan structure's 2D contour follows its 3D flag
    expect(rebuilt[1].visible).toBe(true); // untouched: no override recorded for it
  });

  it('keeps the workspace hold alive while a panel is open', () => {
    vi.useFakeTimers();
    const beat = vi.fn();
    const c = fakeController([]);
    const scope = new ViewScope('validate', c as unknown as ViewerController, beat);
    scope.enter();
    vi.advanceTimersByTime(3 * 60_000); // past HOLD_IDLE_SECONDS with no other traffic
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(2);
    scope.exit();
    const after = beat.mock.calls.length;
    vi.advanceTimersByTime(5 * 60_000);
    expect(beat.mock.calls.length).toBe(after); // and stops once the panel is gone
    vi.useRealTimers();
  });
});
