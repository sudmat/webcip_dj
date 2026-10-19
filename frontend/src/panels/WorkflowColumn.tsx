import type { WorkflowState } from '../api/client';
import type { ViewerController } from '../render/viewerController';
import { ElectrodeTable } from './ElectrodeTable';
import { Structures } from './Structures';
import { useControllerTick } from './ui';

// The left column — the desktop's "Workflow" dock (desktop/main.py::_build_left_dock): the module
// header (Preop/Postop + which ear), the numbered steps, and between them the two unnumbered
// object lists the desktop interleaves — the Structures checklist (step 4's output) and the
// Electrodes table (step 6's).
export function WorkflowColumn({
  controller,
  workflow,
  steps,
  onTakeOver,
  takeover,
  footer,
}: {
  controller: ViewerController;
  /** The session state behind the banner; null until the first fetch. */
  workflow: WorkflowState | null;
  /** The numbered step buttons (see WorkflowSteps). */
  steps?: React.ReactNode;
  /** Claim the shared workspace from whoever holds it. */
  onTakeOver?: () => void;
  /** The Save-file menu. It sits at the FOOT of the column and is deliberately unnumbered —
   *  the desktop keeps it as a plain button below the step list, not as a step
   *  (workflow.py: "workspace save lives here, not in a step"). */
  footer?: React.ReactNode;
  /** A panel that owns the column while it runs (validation, adjust-seg, seed picking …) —
   *  the desktop's WorkflowHost.enter_exclusive, which hides the step list and the
   *  Save/Continue/Back buttons and mounts the panel under the banner. The banner stays,
   *  as it does there (its refresh() only updates the banner while exclusive). */
  takeover?: React.ReactNode;
}) {
  useControllerTick(controller);
  // The banner follows the live SESSION when there is one, and falls back to the opened plan's
  // own header for a plan/cdb opened for review (which does not create a session).
  const planState = controller.plan?.state ?? {};
  const module = String(workflow?.module || planState.module || '');
  const side = String(workflow?.side || planState.side || '');
  const loaded = (workflow?.images.length ?? 0) > 0 || controller.scene.images.length > 0;

  // The banner is fixed, the steps and object lists scroll, and Save file is PINNED under them —
  // the desktop's layout exactly (workflow.py: the step list goes in a QScrollArea added with
  // stretch 1, then the Save button is added after it, so it never scrolls out of reach).
  return (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {loaded || module || side ? (
        <div style={{ display: 'flex', gap: 2 }}>
          <Chip text={cap(module) || '—'} accent />
          <Chip text={side ? `${cap(side)} ear` : '—'} />
        </div>
      ) : (
        <div style={{ color: 'var(--muted)' }}>No images loaded.</div>
      )}
      {controller.readOnly && (
        <div style={{ color: 'var(--warn)' }} title="A .cdb is a tool output — it opens read-only">
          Read-only (.cdb)
        </div>
      )}
      {workflow && !workflow.isMine && (
        <InUse
          since={workflow.holderSince}
          busy={workflow.busy}
          busyLabel={workflow.busyLabel}
          onTakeOver={onTakeOver}
        />
      )}
      {/* enter_exclusive hides the steps, the object lists AND the Save button, leaving only
          the banner above the takeover panel. */}
      {takeover ?? (
        <>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {steps}
            <Structures controller={controller} />
            <ElectrodeTable controller={controller} />
          </div>
          {footer}
        </>
      )}
    </div>
  );
}

/** Someone else is driving the one shared workspace. Two cases, and they deserve different
 *  words: a step is actually RUNNING (taking over would abandon it), or another session merely
 *  touched the workspace recently and the machine is idle. Saying "in use" for both made an idle
 *  server look busy. */
function InUse({
  since,
  busy,
  busyLabel,
  onTakeOver,
}: {
  since: number;
  busy: boolean;
  busyLabel: string;
  onTakeOver?: () => void;
}) {
  const at = since ? new Date(since * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div
      style={{
        padding: '6px 8px',
        border: '1px solid var(--warn-border)',
        background: 'var(--warn-bg)',
        color: 'var(--warn)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div>
        {busy
          ? `Another session is running ${busyLabel || 'a step'}.`
          : `Another session last used this at ${at}. Nothing is running.`}
      </div>
      <button
        onClick={onTakeOver}
        title={
          busy
            ? 'A step is running — taking over now would leave it orphaned'
            : 'Take the workspace and carry on'
        }
      >
        {busy ? 'Take over anyway' : 'Take over'}
      </button>
    </div>
  );
}

function Chip({ text, accent = false }: { text: string; accent?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        textAlign: 'center',
        padding: '4px 8px',
        fontWeight: 700,
        background: accent ? 'var(--accent)' : 'var(--control-bg)',
        color: accent ? 'var(--accent-text)' : 'var(--text)',
        border: '1px solid var(--panel-border)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : '');
