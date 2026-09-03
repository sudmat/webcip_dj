import { useEffect, useRef, useState } from 'react';
import {
  fetchAutoResult,
  fetchAutoState,
  fetchElectrodeOptions,
  startAuto,
  watchAuto,
  type AutoState,
  type CdbData,
  type ElectrodeOption,
} from '../api/client';
import { Bar, MARK, MARK_COLOR, mmss } from './stepProgress';

// Port of desktop/auto_process_dialog.py — run every workflow step unattended, in sequence.
//
// Two dropdowns (Side, Electrode type; Start stays disabled until both are chosen), then one row
// per step with a live marker, its elapsed time and a progress bar, and a Total row:
//
//     •  pending      ⏳ running      ✓ completed      ✗ failed
//
// The steps report INTO THOSE ROWS rather than each opening its own popup — a dozen dialogs
// appearing and vanishing tells you much less than one panel showing where the run is and how
// long each part took. On the web the reports arrive over SSE instead of a progress sink.

export function AutoProcessDialog({
  hasResults,
  onClose,
  onCompleted,
  onProgressResult,
}: {
  /** Whether a previous run's results would be lost (drives the Start confirmation). */
  hasResults: boolean;
  onClose: () => void;
  onCompleted: (result: CdbData) => void;
  /** Each step's output as it lands — the desktop shows results step by step, not only at the
   *  end (a synthetic after Erase, structures after Segment, the lead after Search). */
  onProgressResult: (result: CdbData) => void;
}) {
  const [side, setSide] = useState('');
  const [electrodeId, setElectrodeId] = useState('');
  const [electrodes, setElectrodes] = useState<ElectrodeOption[]>([]);
  const [state, setState] = useState<AutoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stop = useRef<(() => void) | null>(null);
  const shownRev = useRef(0);   // the revision already displayed

  useEffect(() => {
    fetchElectrodeOptions().then(setElectrodes).catch(() => setElectrodes([]));
    // Rejoin a run already in progress (this dialog reopened, or the page was reloaded).
    const prev = sessionStorage.getItem('webcip.autoJob');
    if (prev) {
      fetchAutoState(prev)
        .then((s) => {
          if (s.finished && !s.completed) return;
          setState(s);
          if (!s.finished) follow(s.jobId);
        })
        .catch(() => sessionStorage.removeItem('webcip.autoJob'));
    }
    return () => stop.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function follow(jobId: string) {
    setBusy(true);
    stop.current?.();
    stop.current = watchAuto(jobId, (s) => {
      setState(s);
      // Show each step's output as it lands, not just at the end.
      if (s.revision > shownRev.current) {
        shownRev.current = s.revision;
        const final = s.finished && s.completed;
        fetchAutoResult(jobId)
          .then(final ? onCompleted : onProgressResult)
          .catch((e) => setError(String(e)));
      }
      if (!s.finished) return;
      setBusy(false);
      sessionStorage.removeItem('webcip.autoJob');
      if (s.error) setError(s.error);
    });
  }

  async function onStart() {
    // The desktop asks once, up front, and lists what the run will destroy.
    let text = 'The automatic processing will take several minutes.';
    if (hasResults) text += '\n\nAll previous results will be lost.';
    text += '\n\nContinue?';
    if (!window.confirm(text)) return;
    setError('');
    shownRev.current = 0;
    try {
      const s = await startAuto(side, Number(electrodeId));
      sessionStorage.setItem('webcip.autoJob', s.jobId);
      setState(s);
      follow(s.jobId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const running = busy && !(state?.finished ?? true);
  const steps = state?.steps ?? [];
  const canStart = !running && side !== '' && electrodeId !== '';

  return (
    <Backdrop onClose={running ? undefined : onClose}>
      <div style={panel}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Auto process</div>
        <div style={{ color: 'var(--muted)', marginBottom: 10 }}>
          Runs every step below automatically, in order. Choose the ear side and the electrode
          type, then press Start.
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
          <label style={row}>
            <span style={{ color: 'var(--muted)' }}>Side:</span>
            <select value={side} onChange={(e) => setSide(e.target.value)} disabled={running}>
              <option value="" />
              <option value="left">Left ear</option>
              <option value="right">Right ear</option>
            </select>
          </label>
          <label style={row}>
            <span style={{ color: 'var(--muted)' }}>Electrode type:</span>
            <select
              value={electrodeId}
              onChange={(e) => setElectrodeId(e.target.value)}
              disabled={running}
              style={{ minWidth: 240 }}
            >
              <option value="" />
              {electrodes.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset style={box}>
          <legend style={{ color: 'var(--muted)', padding: '0 4px' }}>Steps</legend>
          {steps.length === 0 && (
            <div style={{ color: 'var(--muted)', padding: '4px 0' }}>
              The steps are listed once the run starts.
            </div>
          )}
          {steps.map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
              <span style={{ width: 18, textAlign: 'center', color: MARK_COLOR[s.status] }}>
                {MARK[s.status]}
              </span>
              <span style={{ flex: 1 }}>{s.label}</span>
              <span style={{ width: 44, textAlign: 'right', color: 'var(--muted)' }}>
                {s.status === 'pending' ? '' : mmss(s.elapsed)}
              </span>
              <Bar status={s.status} frac={s.key === state?.active ? state?.frac ?? null : null} />
            </div>
          ))}
          {steps.length > 0 && (
            <>
              <hr style={{ border: 0, borderTop: '1px solid var(--panel-border)', margin: '6px 0' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 18 }} />
                <span style={{ flex: 1, fontWeight: 600 }}>Total</span>
                <span style={{ width: 44, textAlign: 'right', fontWeight: 700 }}>
                  {mmss(state?.total ?? 0)}
                </span>
                <span style={{ width: 120 }} />
              </div>
            </>
          )}
        </fieldset>

        {/* The running tool's latest log line — the desktop shows this in its busy popup. */}
        {running && state?.line && (
          <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {state.line}
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--err)', marginTop: 8, whiteSpace: 'pre-wrap' }}>{error}</div>
        )}
        {state?.completed && (
          <div style={{ color: 'var(--ok)', marginTop: 8 }}>
            All steps completed. The plan is ready for review.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onStart} disabled={!canStart}>
            Start
          </button>
          {/* No closing mid-run, as the desktop's reject() refuses. */}
          <button onClick={onClose} disabled={running}>
            {state?.completed ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div
      onClick={onClose ? (e) => e.target === e.currentTarget && onClose() : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      {children}
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 620,
  maxWidth: '92vw',
  padding: 14,
  background: 'var(--panel)',
  border: '1px solid var(--panel-border)',
  borderRadius: 6,
};
const box: React.CSSProperties = {
  border: '1px solid var(--panel-border)',
  borderRadius: 4,
  padding: '4px 10px 8px',
};
const row: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
