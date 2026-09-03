import type { ViewerController } from '../render/viewerController';
import {
  ALL_TRAJECTORIES,
  APPROACH_ORDER,
  TRAJ_ROWS,
  approachSiblings,
  trajCell,
  type PlanTrajectory,
} from '../core/planObjects';
import { useControllerTick } from './ui';

// Port of desktop/trajectory_panel.py — CIP's plan-data dock (preop). An "Insertion:" dropdown
// of the generated trajectories over a TRANSPOSED parameter table (columns = the selected
// model's three approaches, rows = the plan parameters, mirroring the IDL insertion property
// sheet) beside the surgical guidance for the selected trajectory.
const SELECTED_BG = '#AED6F1'; // shared selection blue (desktop _fill_table)

export function Insertions({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const trajs = controller.trajectories();
  const active = controller.activeTrajId;
  const showAll = active === ALL_TRAJECTORIES;
  // 'All' has no single selection — show the first model's approaches for context, no tint.
  const chosen: PlanTrajectory | null = showAll ? (trajs[0] ?? null) : controller.activeTrajectory();
  const columns = approachSiblings(trajs, chosen);
  const desc = showAll ? null : chosen?.extra?.cip?.desc;

  if (!trajs.length) {
    return (
      <Shell>
        <span style={{ color: 'var(--muted)' }}>(no insertions — load a preop plan)</span>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ color: 'var(--muted)' }}>Insertion:</span>
        <select value={active ?? ''} onChange={(e) => controller.setActiveTrajectory(e.target.value)}>
          {[...trajs]
            .sort((a, b) => (APPROACH_ORDER[a.extra?.cip?.approach ?? ''] ?? 9) - (APPROACH_ORDER[b.extra?.cip?.approach ?? ''] ?? 9))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          <option value={ALL_TRAJECTORIES}>All</option>
        </select>
        <span style={{ color: 'var(--muted)', marginLeft: 12 }}>Electrode type:</span>
        <select disabled value="model">
          <option value="model">{trajs[0].device_model || '—'}</option>
        </select>
      </div>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ flex: '1 1 420px', minWidth: 0, overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-sm)' }}>
            <thead>
              <tr>
                <th style={hdr} />
                {columns.map((t) => (
                  <th key={t.id} style={hdr}>
                    {t.extra?.cip?.label ?? t.extra?.cip?.approach ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TRAJ_ROWS.map((row) => (
                <tr key={row.key}>
                  <th style={{ ...hdr, textAlign: 'left' }} title={row.tip}>
                    {row.label}
                  </th>
                  {columns.map((t) => {
                    const tinted = showAll || t.id === chosen?.id;
                    return (
                      <td
                        key={t.id}
                        style={{
                          ...cell,
                          background: tinted ? SELECTED_BG : 'transparent',
                          color: tinted ? '#111' : 'inherit',
                        }}
                      >
                        {trajCell(t.extra?.cip, row.key)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            flex: '1 1 380px',
            minWidth: 180,
            overflow: 'auto',
            padding: 8,
            border: '1px solid var(--panel-border)',
            borderRadius: 4,
            background: 'var(--sunken)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {desc?.length ? (
            desc.join('\n\n')
          ) : (
            <span style={{ color: 'var(--muted)' }}>Select an insertion to see its surgical guidance.</span>
          )}
        </div>
      </div>
    </Shell>
  );
}

// Fills whatever height the shell's bottom region gives it (AppShell owns the sizing + header).
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '6px 10px' }}>
      {children}
    </div>
  );
}

const hdr: React.CSSProperties = {
  background: '#e8f2fc',
  color: '#123',
  fontWeight: 700,
  border: '1px solid #c2cfdb',
  padding: '1px 6px',
  whiteSpace: 'nowrap',
};

const cell: React.CSSProperties = {
  border: '1px solid var(--panel-border)',
  padding: '1px 6px',
  textAlign: 'center',
};
