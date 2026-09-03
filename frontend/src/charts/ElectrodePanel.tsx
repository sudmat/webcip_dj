// Electrode tab (D5): mean-distance text + per-electrode data table.
// Ports v2 echarts-webtool.js renderMeanDist + renderTable (ed_chart1).
import type { ElectrodeData } from '../api/client';
import { elecKeys, meanDist, LOCATION_STYLE } from './electrodeShared';
import { ElectrodeCharts } from './ElectrodeCharts';

const fmt = (v: number | undefined, d: number) => (v != null ? (+v).toFixed(d) : '—');

const th: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'center',
  border: '1px solid #e2e8f0',
  color: '#475569',
  fontWeight: 600,
  background: '#f1f5f9',
  position: 'sticky',
  top: 0,
};
const td: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'center',
  border: '1px solid #e2e8f0',
  color: '#475569',
  fontVariantNumeric: 'tabular-nums',
};

// Table + mean-distance only (used stand-alone in the PDF report; `compact` shrinks it for print).
export function ElectrodeTable({ data, compact = false }: { data: ElectrodeData; compact?: boolean }) {
  const keys = elecKeys(data);
  const fs = compact ? 9 : 13;
  const thC = compact ? { ...th, padding: '3px 6px' } : th;
  const tdC = compact ? { ...td, padding: '3px 6px' } : td;
  return (
    <div>
      {!compact && (
        <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', padding: '4px 0 6px' }}>
          Mean Electrode Distance = {meanDist(data).toFixed(2)} mm
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: fs, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thC}>#</th>
              <th style={thC}>Distance (mm)</th>
              <th style={thC}>Angle (°)</th>
              <th style={thC}>Place Freq (Hz)</th>
              <th style={thC}>Ch. Freq (Hz)</th>
              <th style={{ ...thC, textAlign: 'left' }}>Location</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((i) => {
              const loc = data.location[i] || '';
              const s = LOCATION_STYLE[loc] || { bg: '#f8fafc', fg: '#334155' };
              return (
                <tr key={i}>
                  <td style={{ ...tdC, color: '#334155' }}>{i}</td>
                  <td style={tdC}>{fmt(data.min_dist[i], 2)}</td>
                  <td style={tdC}>{fmt(data.angle[i], 1)}</td>
                  <td style={tdC}>{fmt(data.min_freq[i], 0)}</td>
                  <td style={tdC}>{data.c_freq[i] ?? '—'}</td>
                  <td style={{ ...tdC, textAlign: 'left', whiteSpace: 'nowrap' }}>
                    <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: compact ? 9 : 12, fontWeight: 500, background: s.bg, color: s.fg, whiteSpace: 'nowrap' }}>
                      {loc}
                    </span>
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

export function ElectrodePanel({ data }: { data: ElectrodeData }) {
  return (
    <div>
      <ElectrodeTable data={data} />
      <ElectrodeCharts data={data} />
    </div>
  );
}
