import type { AutoStep } from '../api/client';

// The live-step vocabulary, shared by the Auto-process dialog's step table and the workflow
// column's inline progress — a manual step and an automatic one are the same job underneath, so
// they report the same way.
//
//     •  pending      ⏳ running      ✓ completed      ✗ failed

export const MARK: Record<AutoStep['status'], string> = {
  pending: '•',
  running: '⏳',
  done: '✓',
  failed: '✗',
};

export const MARK_COLOR: Record<AutoStep['status'], string> = {
  pending: '#888',
  running: 'var(--info)', // the desktop's #1a5fb4, lightened for a dark panel
  done: 'var(--ok)', // #2a7d2a
  failed: 'var(--err)', // #a33
};

export const mmss = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Indeterminate until a step reports a fraction (the desktop sets range 0,0 as a busy bar). */
export function Bar({
  status,
  frac,
  width = 120,
}: {
  status: AutoStep['status'];
  frac: number | null;
  width?: number | string;
}) {
  const pct = status === 'done' ? 1 : status === 'failed' ? 0 : frac;
  return (
    <div
      style={{
        width,
        height: 10,
        background: 'var(--sunken)',
        border: '1px solid var(--panel-border)',
        overflow: 'hidden',
      }}
    >
      {status === 'running' && pct == null ? (
        <div
          style={{
            width: '35%',
            height: '100%',
            background: MARK_COLOR.running,
            animation: 'wc-indet 1.1s linear infinite',
          }}
        />
      ) : (
        <div
          style={{ width: `${(pct ?? 0) * 100}%`, height: '100%', background: MARK_COLOR[status] }}
        />
      )}
    </div>
  );
}
