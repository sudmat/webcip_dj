import type { ElectrodeRow } from '../api/client';
import type { ViewerController } from '../render/viewerController';
import { scalaTag } from '../core/electrodeData';
import { useControllerTick } from './ui';

// The left column's "Electrodes:" table — the desktop's postop electrode list
// (desktop/main.py's electrode table, rows from projects.cip.electrode.table_rows):
// # / Dist / Angle / Freq / Scala, with the scala cell colour-coded.
//
// Clicking a row selects that electrode everywhere (the Curves graph, the MIP, the 2D/3D
// markers) — the desktop's electrode-selection bus.

// The Curves graph's scala palette (electrode_panel._SCALA_HEX), so the table and the graph agree.
const SCALA_HEX: Record<number, string> = { 0: '#e8241c', 1: '#1a7a2e', 2: '#d99e28', 3: '#5cc24a' };

const num = (v: number | null | undefined, d: number) => (v == null ? '—' : v.toFixed(d));

export function ElectrodeTable({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const e = controller.electrodes;
  if (!e || !e.rows.length) return null;
  const selected = controller.selectedElectrode;

  return (
    <div>
      <div
        style={{ color: 'var(--muted)', fontWeight: 600, padding: '2px 0 4px' }}
        title={e.name}
      >
        Electrodes: <span style={{ fontWeight: 400 }}>{e.model}</span>
      </div>
      <div style={{ maxHeight: 300, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              {['#', 'Dist', 'Angle', 'Freq', 'Scala'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {e.rows.map((r: ElectrodeRow) => {
              const label = Number(r.label);
              const on = label === selected;
              return (
                <tr
                  key={r.label}
                  onClick={() => controller.selectElectrode(on ? null : label)}
                  style={{
                    cursor: 'pointer',
                    background: on ? 'var(--accent)' : 'transparent',
                    color: on ? 'var(--accent-text)' : 'inherit',
                  }}
                  title="Click to centre the views on this electrode"
                >
                  <td style={td}>{r.label}</td>
                  <td style={td}>{num(r.distance, 2)}</td>
                  <td style={td}>{num(r.angle, 1)}</td>
                  <td style={td}>{r.place_freq == null ? '—' : Math.round(r.place_freq)}</td>
                  <td
                    style={{
                      ...td,
                      background: r.scala != null ? SCALA_HEX[r.scala] : 'transparent',
                      color: r.scala != null ? '#fff' : 'inherit',
                      fontWeight: 600,
                    }}
                  >
                    {scalaTag(r.scala)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: 'var(--control-bg)',
  color: 'var(--muted)',
  fontWeight: 600,
  padding: '2px 4px',
  border: '1px solid var(--panel-border)',
};

const td: React.CSSProperties = {
  padding: '1px 4px',
  textAlign: 'center',
  border: '1px solid var(--panel-border)',
};
