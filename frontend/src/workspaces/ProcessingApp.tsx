import { useEffect, useMemo, useRef, useState } from 'react';
import {
  claimWorkflow,
  clearElectrodes,
  clearStructures,
  clearWorkspace,
  fetchCdbMesh,
  fetchPlanMesh,
  fetchVolume,
  fetchAutoResult,
  fetchElectrodeOptions,
  fetchWorkflow,
  loadCdb,
  loadJobFolder,
  loadPath,
  uploadAnyFile,
  uploadFile,
  loadPlan,
  setImageRole,
  runStep,
  setWorkflowSide,
  watchAuto,
  type AutoState,
  isHeldError,
  type CdbData,
  type ElectrodeOption,
  type NumericArray,
  type PlanData,
  type PlanMeshRef,
  type VolumeMeta,
  type WorkflowState,
} from '../api/client';
import { Image } from '../core/image';
import { makePlanStructure, makeTrajMesh, type Structure } from '../core/structure';
import { planStructures, planTrajectories } from '../core/planObjects';
import { ElectrodeDock, type Tab as ElectrodeTab } from '../panels/ElectrodeDock';
import { MenuButton } from '../panels/MenuButton';
import { AutoProcessDialog } from '../panels/AutoProcessDialog';
import { ValidationPanel } from '../panels/ValidationPanel';
import { FourUp } from '../render/FourUp';
import { ViewerController } from '../render/viewerController';
import { RightDock } from '../panels/RightDock';
import { Insertions } from '../panels/Insertions';
import { Toolbar } from '../panels/Toolbar';
import { WorkflowColumn } from '../panels/WorkflowColumn';
import { WorkflowSteps, type StepDef } from '../panels/WorkflowSteps';
import { FilePicker, type PickKind } from '../panels/FilePicker';
import { Bar, mmss } from '../panels/stepProgress';
import { useControllerTick } from '../panels/ui';
import { AppShell } from '../layout/AppShell';

// Processing workspace: the four-up GPU viewer + tools + panels. Mirrors the desktop main window.
//
// Step 1 loads through FilePicker rather than any typed path or baked-in default — the desktop
// opens a file dialog there, and a path constant is wrong on every machine but one.

// Decoded voxels by image id, so a re-display does not refetch a volume already in memory.
const volumeCache = new Map<string, NumericArray>();

export function ProcessingApp() {
  const [autoOpen, setAutoOpen] = useState(false);
  // Which takeover panel owns the left column, or null (the desktop's exclusive panel).
  const [takeover, setTakeover] = useState<'validate' | null>(null);
  // Which picker is open: the four things step 1 can load, or null.
  // The explorer's jobs: a pipeline run (a folder), and loading anything already ON the
  // server — which skips the upload entirely, worth ~3 s on a 400 MB CT plus the browser
  // reading it. The browser's own dialog cannot express either.
  const [picker, setPicker] = useState<'run' | 'preop' | 'postop' | 'cdb' | null>(null);
  // The browser's own file dialog for the three FILE cases. One hidden input, reused; `pending`
  // says what the chosen file is for.
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<'preop' | 'postop' | 'cdb'>('preop');
  const pickFile = (what: 'preop' | 'postop' | 'cdb') => {
    pending.current = what;
    if (fileRef.current) {
      fileRef.current.accept = what === 'cdb' ? '.cdb,.pwi,.pws' : '.nii,.nii.gz,.nrrd,.mha,.mhd,.gz';
      fileRef.current.click();
    }
  };
  // The backend workflow session — the banner and every step's gating come from it.
  const [workflow, setWorkflow] = useState<WorkflowState | null>(null);
  const controllerRef = useRef<ViewerController>(new ViewerController());
  const controller = controllerRef.current;
  useControllerTick(controller); // the plan name + the Insertions dock follow controller state
  const [status, setStatus] = useState('Load a volume (or two), or open a plan, to begin.');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The live manual step: its key, the job state behind the inline progress row, and the key of
  // the step whose last run failed (so the column can mark it).
  const [runningStep, setRunningStep] = useState<string | null>(null);
  const [stepState, setStepState] = useState<AutoState | null>(null);
  const [failedStep, setFailedStep] = useState<string | null>(null);
  const unwatch = useRef<(() => void) | null>(null);
  useEffect(() => () => unwatch.current?.(), []);

  /** Report a failure. A refusal because another session holds the workspace is not an error
   *  to read in the status line — it means the banner is now the thing to look at, so refresh
   *  the state that drives it. */
  const fail = (e: unknown) => {
    setStatus(isHeldError(e) ? 'The workspace is in use by another session.' : `error: ${(e as Error).message}`);
    if (isHeldError(e)) void refreshWorkflow();
  };

  /** Run a mutating action, dealing with the shared workspace first.
   *
   *  Buttons stay ENABLED when someone else holds it: a disabled control that explains nothing
   *  is indistinguishable from a broken one. Instead the click asks, and on confirmation claims
   *  the workspace before doing the work — so a stale hold (a closed tab, a finished script) can
   *  never leave the UI looking dead. */
  async function withHold(action: () => unknown) {
    if (workflow && !workflow.isMine) {
      const at = workflow.holderSince
        ? new Date(workflow.holderSince * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      if (!window.confirm(
        `The workspace is in use by another session${at ? ` since ${at}` : ''}.\n\n` +
          'Take over and continue? The other session will be locked out.',
      ))
        return;
      try {
        setWorkflow(await claimWorkflow());
      } catch (e) {
        fail(e);
        return;
      }
    }
    await action();
  }

  /** Wrap a menu item's onClick so it goes through withHold. */
  const guard = (action: () => unknown) => () => void withHold(action);

  const takeOver = async () => {
    try {
      setWorkflow(await claimWorkflow());
      setStatus('You have the workspace.');
    } catch (e) {
      fail(e);
    }
  };

  const refreshWorkflow = async () => {
    try {
      setWorkflow(await fetchWorkflow());
    } catch {
      /* the banner and gating simply stay as they were */
    }
  };
  useEffect(() => void refreshWorkflow(), []);

  // A takeover panel is a human reading the screen for minutes with no HTTP traffic, and the
  // workspace hold lapses after 3 minutes idle (backend/workflow.py HOLD_IDLE_SECONDS) — which
  // would let another session claim it mid-review. GET /workflow touches the hold, so the
  // scope's heartbeat keeps it alive by refreshing the banner we already show.
  useEffect(() => {
    controller.onScopeHeartbeat = () => void refreshWorkflow();
  }, [controller]);

  // The electrode models behind step 6's 'Electrode type ▶' (the desktop's _all_electrode_options).
  const [electrodeOptions, setElectrodeOptions] = useState<ElectrodeOption[]>([]);
  useEffect(() => {
    fetchElectrodeOptions().then(setElectrodeOptions).catch(() => setElectrodeOptions([]));
  }, []);

  async function ingest(metaPromise: Promise<VolumeMeta>, role: string) {
    setBusy(true);
    setStatus('loading…');
    try {
      // "Load preop CT" starts a new workspace — one patient per plan (the desktop clears first,
      // and so does the backend session, so the browser must follow or it would show stale images).
      if (role === 'preop') controller.clearWorkspace();
      const meta = await metaPromise;
      const img = new Image(meta);
      const { pixels } = await fetchVolume(meta.id);
      img.pixels = pixels;
      controller.addImage(img);
      if (role === 'postop') {
        // The desktop puts the postop on top (it is the FIXED image) with the preop blended
        // under it, and makes it the primary — postop work slices in the postop's frame.
        const preop = controller.scene.images.find((im) => im !== img && im.role === 'preop');
        controller.selectTop(img);
        if (preop) controller.selectBottom(preop);
      }
      const n = controller.scene.images.length;
      setStatus(`${img.name} — ${img.size.join('×')} (${img.orientationLabel})  [${n} loaded]`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      await refreshWorkflow();
    }
  }

  // Open a workspace (.pws / .pwi): images + structures/trajectories + the saved view/UI state.
  // Mirrors desktop main.py::open_workspace.
  async function openPlanAt(from: string) {
    setBusy(true);
    setProblems([]);
    setStatus('opening plan…');
    try {
      const data = await loadPlan(from.trim());
      setStatus(`${data.name}: loading ${data.images.length} image(s)…`);
      const images: Image[] = [];
      for (const meta of data.images) {
        const img = new Image(meta);
        img.pixels = (await fetchVolume(meta.id)).pixels;
        images.push(img);
      }
      setStatus(`${data.name}: loading ${data.meshes.length} mesh(es)…`);
      const structures = await planMeshes(data);
      controller.loadPlan(data, images, structures);
      controller.applyPlanUi(data.ui);
      setProblems([...data.skipped.map((s) => `${s.name}: ${s.reason}`), ...data.warnings]);
      setStatus(
        `${data.name} — ${images.length} image(s), ${data.session.objects.length} planning object(s).`,
      );
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // Open a postop .cdb read-only (desktop main.py's Load CDB). Same flow as a plan.
  async function openCdbAt(from: string) {
    setBusy(true);
    setProblems([]);
    setStatus('opening cdb…');
    try {
      const data = await loadCdb(from.trim());
      await displayCdb(data, '[read-only]');
      setProblems(data.warnings);
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** Show a cdb-shaped payload: fetch its volumes + mesh blobs and hand them to the controller.
   *  Shared by 'Load CDB' and a finished Auto-process run — the run is registered under its job
   *  id in the cdb registry, so the very same fetchers serve it. */
  async function displayCdb(data: CdbData, note = '') {
    setStatus(`${data.name}: loading ${data.images.length} image(s)…`);
    const images: Image[] = [];
    for (const meta of data.images) {
      const img = new Image(meta);
      // Cache voxels by image id. An auto-process run re-displays after EVERY step, and the
      // images do not change between them — without this the ~200-350 MB synthetic would be
      // fetched again on each revision.
      let pixels = volumeCache.get(meta.id);
      if (!pixels) {
        pixels = (await fetchVolume(meta.id)).pixels;
        volumeCache.set(meta.id, pixels);
      }
      img.pixels = pixels;
      images.push(img);
    }
    setStatus(`${data.name}: loading ${data.meshes.length} mesh(es)…`);
    const structures = await cdbMeshes(data);
    controller.loadCdb(data, images, structures);
    // Only once there is actually a lead — a mid-run result has none yet.
    controller.setElectrodePanel(data.electrodes.rows.length > 0);
    setStatus(
      `${data.name} — ${images.length} image(s), ${structures.length} structure(s), ` +
        `${data.electrodes.rows.length} electrode(s) ${note}`.trim(),
    );
  }

  /** A .cdb is not an image, so it is stored as-is and then opened by path. */
  async function uploadThenOpen(f: File) {
    setBusy(true);
    setStatus(`uploading ${f.name}…`);
    try {
      await openResult((await uploadAnyFile(f)).path);
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** The 'Load CDB' button takes either — a .cdb and a .pwi are both finished work, and the
   *  extension picks the loader, so the menu needs no fifth button for plans. */
  async function openResult(p: string) {
    if (/\.(pwi|pws)$/i.test(p)) await openPlanAt(p);
    else await openCdbAt(p);
  }

  /** Reopen a past pipeline run from its output folder — the tool outputs are still on disk
   *  after the result has left the server's memory. Read-only review: it does not touch the
   *  workflow session, so it cannot disturb work in progress. */
  async function openJob(folder: string) {
    setBusy(true);
    setProblems([]);
    setStatus(`opening run ${folder.split('/').pop()}…`);
    try {
      await displayCdb(await loadJobFolder(folder), '[past run]');
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** The Load menu's "Clear workspace": drop the session's images and plan on both sides. */
  async function clearAll() {
    setBusy(true);
    setProblems([]);
    try {
      setWorkflow(await clearWorkspace());
      controller.clearWorkspace();
      volumeCache.clear();
      setStatus('Workspace cleared.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function showResult(data: CdbData) {
    setBusy(true);
    try {
      await displayCdb(data);
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      await refreshWorkflow();   // a step's output changes what the NEXT step may do
    }
  }

  /** Run ONE numbered step and show its output. The same job machinery as Auto process — a
   *  one-step list — so progress arrives over the same SSE stream and the result lands through
   *  the same displayCdb. */
  async function runOne(key: string, electrodeId?: number) {
    setFailedStep(null);
    setProblems([]);
    let shownRev = 0;
    try {
      const s0 = await runStep(key, electrodeId);
      setRunningStep(key);
      setStepState(s0);
      unwatch.current?.();
      unwatch.current = watchAuto(s0.jobId, (s) => {
        setStepState(s);
        if (s.revision > shownRev) {
          shownRev = s.revision;
          fetchAutoResult(s0.jobId)
            .then((r) => void showResult(r))
            .catch((e) => setStatus(`error: ${(e as Error).message}`));
        }
        if (!s.finished) return;
        setRunningStep(null);
        if (s.error) {
          setFailedStep(key);
          setStatus(`${key} failed: ${s.error}`);
        }
        void refreshWorkflow();
      });
    } catch (e) {
      setRunningStep(null);
      // A hold conflict is not a step failure — nothing ran, so do not mark the step failed.
      if (isHeldError(e)) fail(e);
      else {
        setFailedStep(key);
        setStatus(`error: ${(e as Error).message}`);
      }
    }
  }

  // The desktop shows its bottom data dock while the Planning group's "Insertion panel" is on;
  // the dock's own close button turns that same flag back off. A postop cdb shows the electrode
  // dock there instead (the desktop swaps the same dock's contents per module).
  const showInsertions = controller.plan !== null && controller.guidanceOn;
  const showElectrodes = controller.cdbId !== null && controller.electrodePanelOn;

  // The desktop opens this dock at max(350, window height / 2) — "the projection + figures want the
  // room" (projects/cip/__init__.py::_ensure_electrode_panel). Like the desktop's, it is an OPENING
  // height: computed when the dock opens, then the splitter (and the persisted size) own it.
  //
  // Computed once per open, NOT per render. Reading window.innerHeight inline made this a moving
  // target: the panes' ResizeObserver calls controller.refresh() on every layout change, which
  // re-renders this component, which recomputed the size, which resized the dock again — so a
  // window resize visibly stepped its way to a resting size instead of just settling.
  const electrodeDockSize = useMemo(
    () => Math.max(350, Math.round(window.innerHeight / 2)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showElectrodes],
  );

  // --- step 1: Load file (projects/cip/__init__.py::_LoadStep) --------------------------------
  // Four things can be opened, so four buttons, each opening a picker. Nothing is pre-filled and
  // nothing is typed: the desktop opens a file dialog here, and the web equivalent is FilePicker
  // (which browses the SERVER, because a run's folder is gigabytes and a CT is hundreds of MB).
  //
  // "postop: start from a loaded preop. No side requirement" (_LoadStep._load_ct) — the desktop
  // gates that item on `bool(ctx.scene.images)` alone.
  const canPostop = (workflow?.images.length ?? 0) > 0;

  const step1: StepDef = {
    key: 'load',
    gate: 'load',
    title: 'Load file',
    done: (workflow?.images.length ?? 0) > 0,
    items: [
      {
        label: 'Load preop CT …',
        onClick: guard(() => pickFile('preop')),
        title: 'Clears the workspace — one patient per plan',
      },
      {
        label: 'Load postop CT …',
        onClick: guard(() => pickFile('postop')),
        disabled: !canPostop,
        title: canPostop ? undefined : 'Load a preop CT first — start from the preop CT',
      },
      { label: 'Load CDB …', onClick: guard(() => pickFile('cdb')) },
      {
        label: 'Load run …',
        onClick: () => setPicker('run'),
        title: 'A finished pipeline run, rebuilt from its output folder',
      },
      {
        label: 'From a file on the server',
        separatorBefore: true,
        title: 'No upload — the server opens the file where it already is',
        children: [
          { label: 'Preop CT', onClick: guard(() => setPicker('preop')) },
          {
            label: 'Postop CT',
            onClick: guard(() => setPicker('postop')),
            disabled: !canPostop,
            title: canPostop ? undefined : 'Load a preop CT first',
          },
          { label: 'CDB or plan', onClick: guard(() => setPicker('cdb')) },
        ],
      },
      { label: 'Clear workspace', separatorBefore: true, onClick: guard(clearAll) },
    ],
  };

  // --- step 2: Select side (_SideStep) --------------------------------------------------------
  // Left/Right, the current ear checked. Switching sides always warns — "the plan for the …, if
  // not saved or submitted, will be lost" — and on confirm cancels the planning work but keeps
  // the images (ctx.reset_plan_keep_images).
  async function selectSide(side: string) {
    const cur = workflow?.side ?? '';
    if (cur === side) return;                     // the desktop just restores the checkmark
    if (cur) {
      const ok = window.confirm(
        `The plan for the ${SIDE_LABEL[cur] ?? cur}, if not saved or submitted, will be lost.\n\n` +
          'Continue?',
      );
      if (!ok) return;
      controller.clearPlan();                     // the work goes; the images stay
    }
    setBusy(true);
    try {
      setWorkflow(await setWorkflowSide(side));
      setStatus(`Side: ${SIDE_LABEL[side] ?? side}.`);
    } catch (e) {
      fail(e);
      await refreshWorkflow();
    } finally {
      setBusy(false);
    }
  }

  const step2: StepDef = {
    key: 'side',
    gate: 'side',
    title: 'Select side',
    done: !!workflow?.side,
    items: [
      {
        label: 'Left ear',
        checked: workflow?.side === 'left',
        onClick: guard(() => selectSide('left')),
      },
      {
        label: 'Right ear',
        checked: workflow?.side === 'right',
        onClick: guard(() => selectSide('right')),
      },
      {
        label: 'Auto process …',
        separatorBefore: true,
        onClick: () => setAutoOpen(true),
        title: 'Run the whole pipeline unattended (several minutes)',
      },
    ],
  };

  // --- step 3: Register preop to atlas (_RegisterAtlasStep) -----------------------------------
  // The desktop opens its registration panel with the atlas fixed and the preop moving, offering
  // DL / RF / MI. Here it is one click = Deep Learning (autoprocess.run_atlas), the method Auto
  // process uses. Nothing moves on screen: the step only extracts `mat_preop`, so its ✓ and the
  // ungreying of steps 4-6 are the feedback.
  const step3: StepDef = {
    key: 'atlas',
    gate: 'atlas',
    title: 'Register preop to atlas',
    done: !!workflow?.results.registered,
    items: [
      {
        label: 'Register (Deep Learning)',
        onClick: guard(() => runOne('atlas')),
        title: 'Extracts the preop-to-atlas matrix; the image itself does not move',
      },
    ],
  };

  // --- step 4: Segment structures (_SegmentStructuresStep) -------------------------------------
  // Erase implant (jn) then Segment (PCISP), both already runners; 'Adjust …' is the seed-editing
  // panel, deferred. 'Clear all' drops the anatomy and the insertion plan but leaves the
  // postop-anchored implant meshes to step 6's own Clear all.
  async function clearStructuresNow() {
    if (!window.confirm('Remove all segmented structures and any insertion plan?')) return;
    setBusy(true);
    try {
      setWorkflow(await clearStructures());
      controller.clearPlan();
      setStatus('Structures cleared.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function segmentNow() {
    if (
      workflow?.results.structures &&
      !window.confirm('Structures have already been segmented. Re-run and replace them?')
    )
      return;
    if (!window.confirm('This may take a couple of minutes. Continue?')) return;
    void runOne('segment');
  }

  const step4: StepDef = {
    key: 'segment',
    gate: 'segment',
    title: 'Segment structures',
    done: !!workflow?.results.structures,
    items: [
      {
        label: 'Erase implant',
        onClick: guard(() => runOne('erase')),
        title: 'Synthesise an implant-free preop from the implanted scan',
      },
      { label: 'Segment', separatorBefore: true, onClick: guard(segmentNow) },
      { label: 'Adjust …', disabled: true, title: 'Seed editing — not implemented yet' },
      {
        label: 'Clear all',
        separatorBefore: true,
        disabled: !workflow?.results.structures,
        onClick: guard(clearStructuresNow),
      },
    ],
  };

  // --- step 5: Register postop to preop (_RegisterPostopStep) ----------------------------------
  // The desktop opens the registration panel with the preop fixed and the postop moving, offering
  // DL / AMIR global / AMIR local. Here it is one click = DL global then AMIR local on the
  // modiolus — the pairing Auto process uses. Unlike step 3 this one MOVES the postop, so the
  // result is inspectable: the postop comes back visibly aligned over the preop.
  const step5: StepDef = {
    key: 'postop',
    gate: 'postop',
    title: 'Register postop to preop',
    done: !!workflow?.results.postopRegistered,
    items: [
      {
        // The step itself lights up on two distinct CTs (the desktop's is_available), but every
        // method inside its panel needs mat_preop to finish the chain — greyed with this exact
        // wording (_RegisterPostopStep._methods).
        label: 'Register (DL, then local MI on the modiolus)',
        onClick: () => {
          // A synthetic preop was erased FROM this postop, so the two already share a grid —
          // the desktop warns but lets the user proceed (_RegisterPostopStep._register).
          if (
            workflow?.results.synthetic &&
            !window.confirm(
              'The preop is a synthetic image erased from the postop, so the two are already ' +
                'aligned — this registration is unnecessary.\n\nContinue anyway?',
            )
          )
            return;
          void withHold(() => runOne('postop'));
        },
        disabled: !workflow?.results.registered,
        title: workflow?.results.registered
          ? 'Moves the postop onto the preop'
          : 'Register the preop to the atlas first.',
      },
    ],
  };

  // --- step 6: Search for electrodes (_SearchElectrodesStep) -----------------------------------
  // 'Electrode type ▶' is the quick auto-search: a fresh graph run for the chosen model, with the
  // last-searched one checked. 'Pick up seeds …' is the seed panel, deferred — so a search that
  // finds nothing says so rather than offering it.
  async function clearElectrodesNow() {
    if (
      !window.confirm(
        'Remove the electrodes and the two implant meshes? (The segmented structures are left ' +
          'untouched.)',
      )
    )
      return;
    setBusy(true);
    try {
      setWorkflow(await clearElectrodes());
      controller.clearPlan();
      setStatus('Electrodes cleared.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const step6: StepDef = {
    key: 'electrodes',
    gate: 'electrodes',
    title: 'Search for electrodes',
    done: !!workflow?.results.lead,
    items: [
      {
        label: 'Electrode type',
        disabled: electrodeOptions.length === 0,
        children: electrodeOptions.map((o) => ({
          label: o.label,
          checked: workflow?.electrodeId === o.id,
          onClick: guard(() => runOne('electrodes', o.id)),
        })),
      },
      { label: 'Pick up seeds …', disabled: true, title: 'Seed picking — not implemented yet' },
      {
        label: 'Clear all',
        separatorBefore: true,
        disabled: !workflow?.results.lead,
        onClick: guard(clearElectrodesNow),
      },
    ],
  };

  // --- step 7: save file (_SaveStep) ---
  // Save file is NOT a numbered step: the desktop keeps it as a plain button at the FOOT of the
  // column, below the step list and the object lists (workflow.py — "the Save File menu button
  // (workspace save lives here, not in a step)"). Only the review action is live; saving and DB
  // submission need a plan-write path the web does not have.
  //
  // hasImages reads the SCENE, not `workflow`: a .cdb or plan opened for review loads without
  // creating a backend session, and that is exactly the case worth validating.
  const hasImages = controller.scene.images.length > 0;
  const saveFile = (
    <MenuButton
      label="Save file"
      items={[
        {
          label: 'Validate plan …',
          disabled: !hasImages,
          title: hasImages
            ? 'Review the segmentation, the registration and the electrodes'
            : 'Load a preop CT first',
          onClick: () => setTakeover('validate'),
        },
        { label: 'Save plan …', separatorBefore: true, disabled: true, title: 'Plan saving — not implemented yet' },
        { label: 'Submit plan …', disabled: true, title: 'DB submission — not implemented yet' },
      ]}
    />
  );

  const stepColumn = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      <WorkflowSteps
        steps={[step1, step2, step3, step4, step5, step6]}
        workflow={workflow}
        running={runningStep}
        failed={failedStep}
        busy={busy}
      />

      {/* The running step's progress, in the column — the manual counterpart of the Auto-process
          dialog's step table. */}
      {runningStep && stepState && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1 }}>{stepState.steps[0]?.label ?? runningStep}</span>
            <span style={{ color: 'var(--muted)' }}>{mmss(stepState.total)}</span>
          </div>
          <Bar
            status={stepState.steps[0]?.status ?? 'running'}
            frac={stepState.frac ?? null}
            width="100%"
          />
          {stepState.line && (
            <div
              style={{ color: 'var(--muted)', fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={stepState.line}
            >
              {stepState.line}
            </div>
          )}
        </div>
      )}

      {/* Loaded images with their roles — Auto process runs on these. */}
      {controller.scene.images.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {controller.scene.images.map((im) => (
            <div key={im.id} style={{ display: 'flex', gap: 6, fontSize: 'var(--fs-sm)', alignItems: 'center' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={im.name}>
                {im.name}
              </span>
              {/* Editable: correcting a mis-loaded role should not mean re-uploading the volume.
                  It round-trips to the backend, which is what the processing steps read. */}
              <select
                value={im.role}
                style={{ fontSize: 'var(--fs-xs)', padding: '0 2px' }}
                onChange={async (e) => {
                  const next = e.target.value;
                  try {
                    await setImageRole(im.id, next);
                    im.role = next;
                    controller.refresh();
                    await refreshWorkflow();
                  } catch (err) {
                    fail(err);
                  }
                }}
              >
                <option value="">—</option>
                <option value="preop">preop</option>
                <option value="postop">postop</option>
                <option value="synthetic">synthetic</option>
              </select>
            </div>
          ))}
        </div>
      )}

      <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{status}</div>
      {problems.length > 0 && (
        <div style={{ color: 'var(--warn)', fontSize: 'var(--fs-sm)' }} title={problems.join('\n')}>
          opened with {problems.length} problem(s)
        </div>
      )}
    </div>
  );

  return (
    <AppShell
      storageKey="viewer"
      left={{
        title: 'Workflow',
        content: (
          <WorkflowColumn
            controller={controller}
            workflow={workflow}
            steps={stepColumn}
            onTakeOver={() => void takeOver()}
            footer={saveFile}
            takeover={
              takeover === 'validate' ? (
                <ValidationPanel controller={controller} onExit={() => setTakeover(null)} />
              ) : undefined
            }
          />
        ),
      }}
      right={{ title: 'Controls', content: <RightDock controller={controller} /> }}
      bottom={
        showElectrodes && controller.electrodes
          ? {
              title: 'Electrode analysis',
              size: electrodeDockSize,
              content: (
                <ElectrodeDock
                  controller={controller}
                  cdbId={controller.cdbId!}
                  electrodes={controller.electrodes}
                  // A takeover panel puts its own tab in front (validation step 3 wants the
                  // MIP); with no scope open both props are undefined and the dock owns its tab.
                  tab={(controller.scope?.dockTab as ElectrodeTab | undefined) ?? undefined}
                  onTab={(t) => controller.setDockTab(t)}
                />
              ),
              onClose: () => controller.setElectrodePanel(false),
            }
          : showInsertions
            ? {
                // desktop: ctx.set_data_panel(panel, "Insertion plan", height=300)
                title: 'Insertion plan',
                size: 300,
                content: <Insertions controller={controller} />,
                onClose: () => controller.setGuidanceVisible(false),
              }
            : undefined
      }
    >
      <Toolbar controller={controller} />

      <div style={{ flex: 1, minHeight: 0 }}>
        <FourUp controller={controller} />
      </div>

      {/* The browser's own dialog for the file cases — nothing here needs more than that. */}
      <input
        ref={fileRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          const what = pending.current;
          e.target.value = '';
          if (!f) return;
          if (what === 'cdb') void uploadThenOpen(f);
          else void ingest(uploadFile(f, what), what);
        }}
      />

      {/* A pipeline run is a FOLDER of gigabytes that must stay on the server, so it is the one
          case the browser's dialog cannot serve — it browses the server instead. */}
      {picker && (
        <FilePicker
          title={SERVER_PICK[picker].title}
          kind={SERVER_PICK[picker].kind}
          folders={picker === 'run'}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            if (picker === 'run') void openJob(p);
            else if (picker === 'cdb') void openResult(p);
            else void ingest(loadPath(p, undefined, picker), picker);
          }}
        />
      )}

      {autoOpen && (
        <AutoProcessDialog
          hasResults={controller.structures.length > 0}
          onClose={() => setAutoOpen(false)}
          // Each step's output as it lands — matching the desktop, which pushes into its live
          // scene after every step rather than only at the end. The dialog stays open.
          onProgressResult={(result) => void showResult(result)}
          onCompleted={(result) => {
            setAutoOpen(false);
            // The desktop enters validation straight off a clean run (auto_process.py:
            // `if dlg.completed: ctx.validate_plan()`). The result has to land FIRST, or the
            // panel would frame views that are about to be replaced.
            void showResult(result).then(() => setTakeover('validate'));
          }}
        />
      )}
    </AppShell>
  );
}

/** A cdb's meshes: the segmented structures + the implant Lead/Electrodes, all `struct:` blobs
 *  (cdb_scene emits the implants as Structures too). No trajectories in a postop cdb. */
async function cdbMeshes(data: CdbData): Promise<Structure[]> {
  const byKey = new Map<string, PlanMeshRef>(data.meshes.map((m) => [m.key, m]));
  const out: Structure[] = [];
  let index = 0;
  for (const s of planStructures(data.session)) {
    const ref = byKey.get(`struct:${s.id}`);
    if (!ref) continue;
    out.push(makePlanStructure(s, await fetchCdbMesh(data.cdbId, ref), index++));
  }
  return out;
}

/** Fetch every mesh blob in the plan and turn it into a displayed Structure. Plan structures
 *  keep their own colour/opacity/visibility; each trajectory contributes its track cylinder and
 *  carrier coil, whose visibility the controller drives from the Planning toggles. */
async function planMeshes(data: PlanData): Promise<Structure[]> {
  const byKey = new Map(data.meshes.map((m) => [m.key, m]));
  const out: Structure[] = [];
  let index = 0;

  for (const s of planStructures(data.session)) {
    const ref = byKey.get(`struct:${s.id}`);
    if (!ref) continue;
    out.push(makePlanStructure(s, await fetchPlanMesh(data.planId, ref), index++));
  }
  for (const t of planTrajectories(data.session)) {
    for (const [prefix, origin] of [
      ['track', 'plan-track'],
      ['carrier', 'plan-carrier'],
    ] as const) {
      const ref = byKey.get(`${prefix}:${t.id}`);
      if (!ref) continue;
      out.push(makeTrajMesh(origin, t, await fetchPlanMesh(data.planId, ref), index++));
    }
  }
  return out;
}

const SIDE_LABEL: Record<string, string> = { left: 'left ear', right: 'right ear' };

// The explorer's four uses. No upload happens for any of them — the server opens what is
// already on its own disk, which is why these exist alongside the browser's file dialog.
const SERVER_PICK: Record<string, { title: string; kind: PickKind }> = {
  preop: { title: 'Preop CT — a file on the server', kind: 'image' },
  postop: { title: 'Postop CT — a file on the server', kind: 'image' },
  cdb: { title: 'CDB or plan — a file on the server', kind: 'cdb' },
  run: { title: 'Pipeline run — choose its output folder', kind: 'any' },
};
