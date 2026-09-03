// Curves tab (D5): v3 renderCurves — one distance-vs-frequency line per electrode.
// X = log frequency (computed [xMin,xMax], v3 FREQ_TICKS), Y = distance (mm) 0..4, 22-colour
// palette, clickable legend to show/hide an electrode.
import { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Label,
  ReferenceDot,
  ResponsiveContainer,
} from 'recharts';
import type { ElectrodeData } from '../api/client';
import { FREQ_TICKS, ELECTRODE_PALETTE, curveXRange, CHART_H } from './electrodeShared';
import { FreqTick } from './ElectrodeCharts';

const AX = { fontSize: 12, fill: '#1e293b' };
const GRID = '#e6eaf1';

// Curves plot geometry (for the nearest-point tooltip): domain [0,4] over the inner plot rect.
const Y_MAX = 4;
const PLOT_TOP = 8; // margin.top
const PLOT_BOTTOM = CHART_H - (40 + 56); // height − margin.bottom − XAxis height

// Show only the ONE electrode whose curve is closest to the cursor (not the whole vertical slice).
function NearestTooltip(props: {
  active?: boolean;
  label?: number | string;
  payload?: Array<{ value?: number | null; name?: string }>;
  coordinate?: { x: number; y: number };
}) {
  const { active, payload, label, coordinate } = props;
  if (!active || !payload?.length || !coordinate) return null;
  const yPix = (v: number) => PLOT_BOTTOM - (v / Y_MAX) * (PLOT_BOTTOM - PLOT_TOP);
  let best: { value?: number | null; name?: string } | null = null;
  let bestD = Infinity;
  for (const p of payload) {
    if (p.value == null) continue;
    const d = Math.abs(yPix(p.value) - coordinate.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || best.value == null) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}>
      Electrode {best.name} · {Number(label).toFixed(1)} Hz · {best.value.toFixed(1)} mm
    </div>
  );
}

export function CurvesPanel({
  data,
  active,
  onToggle,
  height = CHART_H,
}: {
  data: ElectrodeData;
  active: Set<number>;
  onToggle: (elec: number) => void;
  height?: number;
}) {
  const elec = Object.keys(data.raw)
    .map(Number)
    .sort((a, b) => a - b);
  const freqs = data.curvefreqs;

  const { xMin, xMax } = curveXRange(data);
  const ticks = FREQ_TICKS.filter((v) => v >= xMin && v <= xMax);

  // Electrodes share curvefreqs, so one row per frequency with an e<num> column each.
  const rows = freqs.map((f, fi) => {
    const r: Record<string, number | null> = { freq: f };
    for (const i of elec) {
      const v = data.raw[i][fi];
      r[`e${i}`] = v === -1 ? null : v;
    }
    return r;
  });

  // Single nearest point under the cursor (v3 nearest/intersect pick — not the whole x slice).
  const [hover, setHover] = useState<{ freq: number; dist: number } | null>(null);
  const yPix = (v: number) => PLOT_BOTTOM - (v / Y_MAX) * (PLOT_BOTTOM - PLOT_TOP);
  const onMove = (state: {
    isTooltipActive?: boolean;
    chartY?: number;
    activePayload?: Array<{ value?: number | null; payload?: { freq: number } }>;
  }) => {
    const pl = state?.activePayload;
    if (!state?.isTooltipActive || !pl?.length || state.chartY == null) return setHover(null);
    let best: { value?: number | null; payload?: { freq: number } } | null = null;
    let bd = Infinity;
    for (const p of pl) {
      if (p.value == null) continue;
      const d = Math.abs(yPix(p.value) - state.chartY);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    setHover(best && best.value != null && best.payload ? { freq: best.payload.freq, dist: best.value } : null);
  };

  return (
    <div>
      <div style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
        Electrode Curves
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 40, left: 8 }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <CartesianGrid stroke={GRID} />
          <XAxis
            type="number"
            dataKey="freq"
            scale="log"
            domain={[xMin, xMax]}
            ticks={ticks}
            interval={0}
            allowDataOverflow
            height={56}
            tick={<FreqTick />}
          >
            <Label value="Frequency (Hz)" position="insideBottom" offset={-2} style={{ fontSize: 13, fill: '#0f172a' }} />
          </XAxis>
          <YAxis type="number" domain={[0, 4]} tick={AX} width={44}>
            <Label value="Distance (mm)" angle={-90} position="insideLeft" style={{ fontSize: 13, fill: '#0f172a', textAnchor: 'middle' }} />
          </YAxis>
          <Tooltip content={<NearestTooltip />} isAnimationActive={false} />
          <Legend
            verticalAlign="top"
            iconType="plainline"
            onClick={(o) => {
              const k = String((o as { dataKey?: string }).dataKey || '');
              if (k.startsWith('e')) onToggle(Number(k.slice(1)));
            }}
            wrapperStyle={{ fontSize: 11, cursor: 'pointer' }}
          />
          {elec.map((i, idx) => (
            <Line
              key={`e${i}`}
              dataKey={`e${i}`}
              name={String(i).padStart(2, '0')}
              stroke={ELECTRODE_PALETTE[idx % ELECTRODE_PALETTE.length]}
              strokeWidth={1.5}
              dot={false}
              activeDot={false}
              hide={!active.has(i)}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
          {hover && (
            <ReferenceDot x={hover.freq} y={hover.dist} r={5} fill="#0f172a" stroke="#fff" strokeWidth={1.5} ifOverflow="visible" />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
