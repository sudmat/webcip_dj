import { describe, expect, it } from 'vitest';
import {
  boxAxisPoint,
  boxCenter,
  boxMaxExtent,
  fitZoom,
  meshCentroid,
  parallelScaleFor,
  structuresWorldBbox,
} from '../viewFit';
import { preopImage, postopImage } from '../roles';
import { NONE_CHECKED, doneEnabled, nextStep, stepStates } from '../validationSteps';
import type { Structure } from '../structure';
import type { Image } from '../image';

// A Structure with nothing but the geometry the fit math reads.
function struct(points: number[], visible = true): Structure {
  return {
    id: 's',
    group: 'structures',
    index: 0,
    origin: 'plan-structure',
    name: 's',
    label: 's',
    typeId: 0,
    color: [1, 1, 1],
    opacity: 1,
    renderOrder: 0,
    visible,
    visible2d: visible,
    mesh: { points: new Float32Array(points), normals: new Float32Array(), tris: new Uint32Array() },
  };
}

describe('structuresWorldBbox', () => {
  it('unions every mesh', () => {
    const box = structuresWorldBbox([
      struct([0, 0, 0, 1, 2, 3]),
      struct([-1, 5, 0, 0, 0, 10]),
    ]);
    expect(box).toEqual({ lo: [-1, 0, 0], hi: [1, 5, 10] });
  });

  // The desktop iterates session.of_kind("structure") with no .visible filter: the box frames
  // the segmentation, not the checklist. Step 2 hides everything, so a filtered box would
  // collapse to null the moment the human checked step 1.
  it('includes hidden structures', () => {
    const box = structuresWorldBbox([struct([0, 0, 0], true), struct([9, 9, 9], false)]);
    expect(box?.hi).toEqual([9, 9, 9]);
  });

  it('is null when nothing has geometry', () => {
    expect(structuresWorldBbox([])).toBeNull();
    expect(structuresWorldBbox([struct([])])).toBeNull();
  });

  it('handles a single point', () => {
    expect(structuresWorldBbox([struct([2, 3, 4])])).toEqual({ lo: [2, 3, 4], hi: [2, 3, 4] });
  });
});

describe('boxCenter / boxMaxExtent', () => {
  const box = { lo: [0, 0, 0] as [number, number, number], hi: [10, 4, 30] as [number, number, number] };

  it('centres on the midpoint, not a centroid', () => {
    expect(boxCenter(box)).toEqual([5, 2, 15]);
  });

  it('takes the largest side, not the diagonal or the mean', () => {
    expect(boxMaxExtent(box)).toBe(30);
  });

  it('is 0 for a degenerate box', () => {
    expect(boxMaxExtent({ lo: [1, 1, 1], hi: [1, 1, 1] })).toBe(0);
  });
});

describe('fitZoom', () => {
  // validation_panel.py:212 — the padded box fills 1/1.4 of the pane.
  it('frames the box with 1.4x padding', () => {
    expect(fitZoom(256, 30)).toBeCloseTo(256 / (30 * 1.4), 10);
  });

  // The desktop always has fov_mm 256; a .cdb on the web sets it to the crop extent * 1.15,
  // so the formula has to read the live value and still put 1.4*extent in view.
  it('puts 1.4 * extent in view whatever the fov', () => {
    for (const fov of [256, 45.3, 12]) {
      const z = fitZoom(fov, 8);
      if (z > 1) expect(fov / z).toBeCloseTo(8 * 1.4, 10);
    }
  });

  it('never zooms out past 1.0', () => {
    expect(fitZoom(45, 100)).toBe(1);
    expect(fitZoom(256, 1e9)).toBe(1);
  });

  it('survives a degenerate extent via the 1e-3 floor', () => {
    expect(fitZoom(256, 0)).toBe(256 / 1e-3);
    expect(Number.isFinite(fitZoom(256, 0))).toBe(true);
  });
});

describe('parallelScaleFor', () => {
  // VTK's parallel scale is the viewport HALF-height, so 2*scale must equal the 2D pane's
  // fovMm/zoom field for the two views to show the same physical extent.
  it('is half the 2D visible field', () => {
    expect(parallelScaleFor(256, 20)).toBeCloseTo(6.4, 10);
    for (const [fov, zoom] of [
      [256, 1],
      [256, 20],
      [45.3, 7.5],
    ]) {
      expect(2 * parallelScaleFor(fov, zoom)).toBeCloseTo(fov / zoom, 10);
    }
  });

  it('clamps at 1e-3 rather than collapsing to zero', () => {
    expect(parallelScaleFor(256, Infinity)).toBe(1e-3);
  });
});

describe('boxAxisPoint', () => {
  const box = { lo: [0, 10, 100] as [number, number, number], hi: [2, 20, 300] as [number, number, number] };
  const ch: [number, number, number] = [-5, -5, -5];

  it('sweeps lo -> hi as t goes 0 -> 1', () => {
    expect(boxAxisPoint(box, 1, ch, 0)[1]).toBe(10);
    expect(boxAxisPoint(box, 1, ch, 0.5)[1]).toBe(15);
    expect(boxAxisPoint(box, 1, ch, 1)[1]).toBe(20);
  });

  // Each slider owns one axis; disturbing the others would scroll the other two panes.
  it('leaves the other two components untouched', () => {
    expect(boxAxisPoint(box, 0, ch, 0.25)).toEqual([0.5, -5, -5]);
    expect(boxAxisPoint(box, 2, ch, 1)).toEqual([-5, -5, 300]);
  });

  it('does not mutate the crosshair it was given', () => {
    boxAxisPoint(box, 0, ch, 1);
    expect(ch).toEqual([-5, -5, -5]);
  });
});

describe('meshCentroid', () => {
  it('is the vertex mean', () => {
    expect(meshCentroid(new Float32Array([0, 0, 0, 2, 4, 6]))).toEqual([1, 2, 3]);
  });

  it('is null with no geometry', () => {
    expect(meshCentroid(new Float32Array())).toBeNull();
    expect(meshCentroid(null)).toBeNull();
  });
});

describe('image roles', () => {
  const img = (id: string, role: string) => ({ id, role }) as Image;
  /** A role-tagged session: the slots are irrelevant, the roles decide. */
  const tagged = (...images: Image[]) => ({ images, top: images[0] ?? null, bottom: null });

  it('prefers the synthetic as the preop once it exists', () => {
    expect(preopImage(tagged(img('a', 'preop'), img('b', 'synthetic'), img('c', 'postop')))?.id).toBe('b');
  });

  it('falls back to the preop role', () => {
    expect(preopImage(tagged(img('a', 'postop'), img('b', 'preop')))?.id).toBe('b');
  });

  it('finds the postop by role, and reports none when there is none', () => {
    expect(postopImage(tagged(img('a', 'preop'), img('b', 'postop')))?.id).toBe('b');
    expect(postopImage(tagged(img('a', 'preop')))).toBeNull();
  });

  // A .cdb carries no roles: cdb_scene.py puts the postop on top and the preop underneath, and
  // a preop-only cdb puts that lone preop on top with no bottom.
  it('reads a role-less pair from the slots (a .cdb)', () => {
    const post = img('post', '');
    const pre = img('pre', '');
    const cdb = { images: [post, pre], top: post, bottom: pre };
    expect(preopImage(cdb)?.id).toBe('pre');
    expect(postopImage(cdb)?.id).toBe('post');
  });

  it('treats a lone role-less image as the preop, with no postop', () => {
    const only = img('only', '');
    const single = { images: [only], top: only, bottom: null };
    expect(preopImage(single)?.id).toBe('only');
    expect(postopImage(single)).toBeNull();
  });

  it('is null on an empty scene', () => {
    expect(preopImage({ images: [], top: null, bottom: null })).toBeNull();
    expect(postopImage({ images: [], top: null, bottom: null })).toBeNull();
  });
});

describe('validation step gating', () => {
  it('opens only the first step, and only its controls', () => {
    const s = stepStates(NONE_CHECKED);
    expect(s.map((x) => x.active)).toEqual([true, false, false]);
    expect(s.map((x) => x.showCheck)).toEqual([true, false, false]);
    expect(s.map((x) => x.controlsEnabled)).toEqual([true, false, false]);
    expect(doneEnabled(NONE_CHECKED)).toBe(false);
  });

  it('advances one step per check, and a checked step keeps its controls live', () => {
    const s = stepStates({ ...NONE_CHECKED, structures: true });
    expect(s[0]).toMatchObject({ checked: true, showCheck: false, controlsEnabled: true });
    expect(s[1]).toMatchObject({ active: true, showCheck: true, controlsEnabled: true });
    expect(s[2].enabled).toBe(false);
  });

  it('unlocks Done only when all three are checked', () => {
    expect(doneEnabled({ structures: true, registration: true, electrodes: false })).toBe(false);
    expect(doneEnabled({ structures: true, registration: true, electrodes: true })).toBe(true);
  });

  // A preop-only plan has nothing to flip, but must still be able to reach Done — the desktop
  // disables step 2's controls and leaves its "Checked" button alone.
  it('disables step 2 controls without a postop but keeps it checkable', () => {
    const s = stepStates({ ...NONE_CHECKED, structures: true }, false);
    expect(s[1].controlsEnabled).toBe(false);
    expect(s[1].showCheck).toBe(true);
  });

  it('names the step whose setup follows a check', () => {
    expect(nextStep('structures')).toBe('registration');
    expect(nextStep('registration')).toBe('electrodes');
    expect(nextStep('electrodes')).toBeNull();
  });
});
