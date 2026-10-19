import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewerController } from '../render/viewerController';
import { preopImage, postopImage } from '../core/roles';
import { boxAxisPoint, boxCenter, boxMaxExtent, fitZoom, structuresWorldBbox } from '../core/viewFit';
import {
  NONE_CHECKED,
  doneEnabled,
  nextStep,
  stepStates,
  type Checked,
  type StepKey,
} from '../core/validationSteps';
import { useControllerTick } from './ui';

// The post-auto-process review — a port of desktop/validation_panel.py::ValidationPanel.
//
// Three steps a human must confirm in order, each framing the views on what it is asking about.
// Checking one activates the next; Done unlocks only when all three are checked; Cancel and Done
// both leave by the same route. There is no "reject": a step that looks wrong is answered by
// leaving and re-running that pipeline step.
//
// The panel takes the views over through controller.enterScope (render/viewScope.ts) and so saves
// NOTHING itself — every setter it calls below is covered by the scope's snapshot and undone on
// exit. That is the difference from the desktop, where this panel hand-rolls a `_saved` tuple and
// consequently restores neither the per-pane pan nor the 3D camera.
//
// NOT PORTED: the desktop's Done also stamps the plan — session.state['validated'] = {at, by, sig},
// where sig is db_plan.validation_signature over the plan content, so the stamp self-invalidates
// on a real edit and gates the DB order's READY flip. The web has no save route for plan state and
// no authenticated identity to put in `by`, so a stamp here would certify nothing while implying
// it does. Done therefore just closes.

/** The desktop's one-shot default_zoom['electrode'] (projects/cip/__init__.py::_DEFAULT_ZOOM),
 *  which the validation panel force-re-arms so its first electrode framing always happens. */
const ELECTRODE_ZOOM = 20;

const SLIDER_STEPS = 200; // validation_panel._SLIDER_STEPS

/** Which world axis each pane's slider scrubs (validation_panel._axis_sliders). */
const AXIS_SLIDERS: { label: string; axis: 0 | 1 | 2 }[] = [
  { label: 'Coronal', axis: 1 },
  { label: 'Sagittal', axis: 0 },
  { label: 'Axial', axis: 2 },
];

export function ValidationPanel({
  controller,
  onExit,
}: {
  controller: ViewerController;
  onExit: () => void;
}) {
  useControllerTick(controller);
  const [checked, setChecked] = useState<Checked>(NONE_CHECKED);
  const [axisPos, setAxisPos] = useState<[number, number, number]>([100, 100, 100]);
  const [showPostop, setShowPostop] = useState(false);
  const [elIdx, setElIdx] = useState(1);
  const [labels, setLabels] = useState<number[]>([]);
  const firstPick = useRef(true); // not rendered: only decides whether a pick also zooms
  // Done leaves the views where the review put them; Cancel puts the framing back. Read by the
  // unmount cleanup, which is the single exit path for both buttons.
  const keepView = useRef(false);

  // Derived, not stored: it gates and drives step 1's sliders, and recomputing only when the
  // structure list itself changes keeps a full vertex pass off every re-render (the controller
  // emits on each crosshair move). It also means a mid-review pipeline revision reframes to the
  // structures that now exist rather than to a box captured at step 1.
  const box = useMemo(() => structuresWorldBbox(controller.structures), [controller.structures]);

  // Resolved ONCE, from the scene as it was on mount — the desktop likewise takes both as
  // constructor arguments (_preop_ct / _postop_ct, evaluated before the panel touches anything).
  // It has to be: step 1 selects the preop as top, which clears the bottom slot, so re-deriving
  // from the live slots would lose the postop and leave step 2 with nothing to flip to.
  const [preop] = useState(() => preopImage(controller.scene));
  const [postop] = useState(() => postopImage(controller.scene));
  const hasPostop = postop !== null;

  // --- step activations (validation_panel._activate_*) --------------------------------------

  /** Step 2: every structure hidden, so the preop/postop flip shows the CT alone. */
  const activateRegistration = useCallback(() => {
    for (const s of controller.planStructures()) controller.updateStructure(s.id, { visible: false });
    setShowPostop(false);
    if (preop) controller.selectTop(preop);
  }, [controller, preop]);

  const pickElectrode = useCallback(
    (label: number) => {
      // The first pick frames the contact; the rest only re-centre, so stepping through the
      // array doesn't keep slamming the zoom (the desktop gets this from its one-shot).
      controller.selectElectrode(label, firstPick.current ? ELECTRODE_ZOOM : undefined);
      firstPick.current = false;
    },
    [controller],
  );

  /** Step 3: postop alone with the localized leads on, and the MIP tab in front. */
  const activateElectrodes = useCallback(() => {
    if (postop) controller.selectTop(postop); // structures stay hidden from step 2
    controller.setLeadsVisible(true);
    controller.setElectrodePanel(true);
    controller.setDockTab('mip');
    const found = controller
      .contacts()
      .map((c) => Number(c.label))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b); // numerically — the desktop int()s the labels before sorting
    setLabels(found);
    setElIdx(1);
    firstPick.current = true;
    if (found.length) pickElectrode(found[0]);
  }, [controller, postop, pickElectrode]);

  // --- lifecycle -----------------------------------------------------------------------

  // Claim the views. Deliberately alone in its own effect: under StrictMode React runs this as
  // enter -> exit -> enter, which only round-trips because entering is inert. Folding the scene
  // setup below into it would make the second snapshot capture step 1 instead of the real state.
  useEffect(() => {
    controller.enterScope('validate');
    return () => controller.exitScope(keepView.current);
  }, [controller]);

  // A clean review scene, then step 1's framing: single preop on the atlas axes, framed on the
  // whole segmentation. The desktop's _enter() unchecks the 3D-image box and the whole Planning
  // group, then calls _activate_structures; all of it is ordinary setters the scope will undo.
  //
  // Runs once, after the scope is entered. Everything it touches is the renderer — an external
  // system this is synchronizing, which is what an effect is for.
  useEffect(() => {
    controller.setTrajectoriesVisible(false);
    controller.setAbVisible(false);
    controller.setGuidanceVisible(false);
    controller.setLeadsVisible(false);
    controller.setElectrodePanel(false);
    controller.set3dMode('none');
    controller.setTool('position');
    if (preop) controller.selectTop(preop); // clears the bottom slot, like set_top_image
    controller.setOrientationMode('original'); // identity == the atlas / world axes
    if (box) {
      // fovMm is read LIVE: a .cdb sets it to the crop's extent, not the desktop's fixed 256.
      controller.setZoom(fitZoom(controller.scene.view.fovMm, boxMaxExtent(box)));
      controller.moveCrosshairTo(boxCenter(box)); // 2D only, as the desktop's step 1 is
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- gating --------------------------------------------------------------------------

  const check = (key: StepKey) => {
    setChecked((c) => ({ ...c, [key]: true }));
    const next = nextStep(key);
    if (next === 'registration') activateRegistration();
    if (next === 'electrodes') activateElectrodes();
  };

  const states = stepStates(checked, hasPostop);
  const rows: Record<StepKey, React.ReactNode> = {
    structures: (
      <AxisSliders
        enabled={states[0].controlsEnabled && box !== null}
        pos={axisPos}
        onChange={(i, v) => {
          const b = box;
          if (!b) return;
          const next = [...axisPos] as [number, number, number];
          next[i] = v;
          setAxisPos(next);
          const { axis } = AXIS_SLIDERS[i];
          controller.moveCrosshairTo(
            boxAxisPoint(b, axis, controller.scene.view.crosshair as [number, number, number], v / SLIDER_STEPS),
          );
        }}
      />
    ),
    registration: (
      <button
        disabled={!states[1].controlsEnabled}
        title={hasPostop ? 'Flip between the two scans to judge the alignment' : 'No postop image in this plan'}
        onClick={() => {
          const next = !showPostop;
          setShowPostop(next);
          const img = next ? postop : preop;
          // Steady only because step 1 put us in 'original' mode: selectTop re-derives the
          // orientation from the new top, which is identity either way there. In 'primary' mode
          // this flip would rotate the panes.
          if (img) controller.selectTop(img);
        }}
      >
        Showing: {showPostop ? 'Postop' : 'Preop'} — click to flip
      </button>
    ),
    electrodes: (
      <ElectrodeSlider
        enabled={states[2].controlsEnabled && labels.length > 0}
        count={labels.length}
        index={elIdx}
        label={labels[elIdx - 1]}
        onChange={(v) => {
          setElIdx(v);
          const label = labels[v - 1];
          if (label !== undefined) pickElectrode(label);
        }}
      />
    ),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>Validate plan</div>
      <div style={{ color: 'var(--muted)' }}>
        Check each result before the plan is treated as reviewed.
      </div>

      {states.map((s) => (
        <div
          key={s.key}
          style={{
            border: '1px solid var(--panel-border)',
            borderRadius: 4,
            padding: '6px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            opacity: s.enabled ? 1 : 0.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1, fontWeight: 600, color: s.checked ? 'var(--ok)' : 'var(--text)' }}>
              {s.checked ? `✓  ${s.label}` : s.label}
            </div>
            {s.showCheck && <button onClick={() => check(s.key)}>Checked</button>}
          </div>
          {rows[s.key]}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          style={{ flex: 1 }}
          disabled={!doneEnabled(checked)}
          title="Finish the review and keep these views"
          onClick={() => {
            keepView.current = true;
            onExit();
          }}
        >
          Done
        </button>
        <button style={{ flex: 1 }} title="Leave the review and put the views back" onClick={onExit}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Step 1's three sliders: each sweeps the crosshair along one world axis of the structures'
 *  bounding box, so the human can scan the segmentation without leaving the panel. */
function AxisSliders({
  enabled,
  pos,
  onChange,
}: {
  enabled: boolean;
  pos: [number, number, number];
  onChange: (i: number, v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {AXIS_SLIDERS.map((s, i) => (
        <label key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: '5.5em', color: 'var(--muted)', flexShrink: 0 }}>{s.label}</span>
          <input
            type="range"
            min={0}
            max={SLIDER_STEPS}
            value={pos[i]}
            disabled={!enabled}
            onChange={(e) => onChange(i, Number(e.target.value))}
            style={{ flex: 1, minWidth: 0 }}
          />
        </label>
      ))}
    </div>
  );
}

/** Step 3's slider: steps through the localized contacts, centring each in turn. */
function ElectrodeSlider({
  enabled,
  count,
  index,
  label,
  onChange,
}: {
  enabled: boolean;
  count: number;
  index: number;
  label: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: '7em', color: 'var(--muted)', flexShrink: 0 }}>
        {label === undefined ? 'No electrodes' : `Electrode ${label}`}
      </span>
      <input
        type="range"
        min={1}
        max={Math.max(1, count)}
        value={index}
        disabled={!enabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
    </div>
  );
}
