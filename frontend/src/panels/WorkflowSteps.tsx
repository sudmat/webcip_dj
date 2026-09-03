import type { WorkflowState } from '../api/client';
import { MenuButton, type MenuItem } from './MenuButton';

// The desktop's numbered workflow steps (projects/cip/__init__.py::_CipModule.steps, laid out by
// desktop/workflow.py). Each step is one button + its options; a step is greyed until its own
// is_available holds, which the backend computes and ships in `workflow.available` — so the rule
// lives in one place instead of being restated here.
//
// Step 7 (Save file) is out of scope for now.

export interface StepDef {
  key: string;
  /** The gating key in `workflow.available`. */
  gate: string;
  title: string;
  items: MenuItem[];
  /** Shown under the button — the web needs typed paths where the desktop opens a file dialog. */
  body?: React.ReactNode;
  /** Overrides the derived marker (a step whose result is a stored matrix has no other feedback). */
  done?: boolean;
}

export function WorkflowSteps({
  steps,
  workflow,
  running,
  failed,
  busy,
}: {
  steps: StepDef[];
  workflow: WorkflowState | null;
  /** Key of the step whose job is live, if any. */
  running: string | null;
  /** Key of the step whose last run failed. */
  failed: string | null;
  busy: boolean;
}) {
  const available = workflow?.available ?? {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((s, i) => {
        // A step is greyed by its own precondition, and every step is inert while one is running
        // (the backend allows one at a time; showing that up front beats a 409).
        const ready = available[s.gate] !== false;
        const status = running === s.key
          ? 'running'
          : failed === s.key
            ? 'failed'
            : s.done
              ? 'done'
              : 'idle';
        return (
          <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <MenuButton
              label={`${i + 1}. ${s.title}`}
              items={s.items}
              disabled={!ready || busy || running !== null}
              status={status}
              title={ready ? s.title : `Not available yet — ${GATE_HINT[s.gate] ?? 'earlier steps first'}`}
            />
            {s.body && ready && <div style={{ paddingLeft: 6 }}>{s.body}</div>}
          </div>
        );
      })}
    </div>
  );
}

// Why a step is greyed — the is_available predicates, in words.
const GATE_HINT: Record<string, string> = {
  side: 'load an image first',
  atlas: 'select the side first',
  segment: 'register the preop to the atlas first',
  postop: 'needs a preop and a postop CT',
  electrodes: 'needs segmented structures and a postop CT',
};
