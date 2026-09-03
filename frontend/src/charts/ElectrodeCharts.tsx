// Electrode Data charts (D5), ported from v3 echarts-webtool.js (Chart.js) into Recharts.
// Each chart is exported individually (so the PDF can lay them out in a row) and ElectrodeCharts
// stacks the three for the Electrode Data tab. v3 specifics: freq axis = FREQ_TICKS on log
// [500,20000] with thousands labels; electrode# axis linear stepSize 4; angle-by-freq is a line.
//
// Two shared options:
//   `dark`  — palette for a dark surface. The Display workspace puts these on a white panel (v3),
//             but the viewer's Electrode-analysis dock is dark, where the v3 ink is unreadable.
//   `selectedLabel` — rings that electrode's point in EVERY series, the desktop's cross-chart
//             selection highlight (electrode_panel._FigureTab._mark_selected: an open circle,
//             ms=13 mew=2, on each line of the figure).
import {
  ComposedChart,
  LineChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceDot,
  Tooltip,
  Legend,
  Label,
  ResponsiveContainer,
} from 'recharts';
import type { ElectrodeData } from '../api/client';
import { elecKeys, elecTicks, FREQ_TICKS, FREQ_MIN, FREQ_MAX, freqLabel, CHART_COLOR as C } from './electrodeShared';

interface Themed {
  dark?: boolean;
  /** Electrode number to ring across every series (the shared selection), or null. */
  selectedLabel?: number | null;
}

const THEME = {
  light: { ink: '#1e293b', title: '#0f172a', grid: '#e6eaf1', ring: '#000000' },
  dark: { ink: '#c3ccd6', title: '#e8ecf0', grid: '#4a5560', ring: '#ffffff' },
};
const theme = (dark?: boolean) => (dark ? THEME.dark : THEME.light);

const oneDp = (v: unknown) => (typeof v === 'number' ? v.toFixed(1) : (v as string));

/** `height: '100%'` fills the parent instead of taking a fixed pixel height — the viewer's dock is
 *  user-resizable, so its chart should grow with it; the Display workspace stacks three at fixed
 *  heights in a scrolling column. */
type ChartHeight = number | '100%';

function ChartCard({
  title,
  height,
  dark,
  children,
}: {
  title: string;
  height: ChartHeight;
  dark?: boolean;
  children: React.ReactElement;
}) {
  const fill = height === '100%';
  return (
    <div
      style={
        fill
          ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, paddingTop: 6 }
          : { marginTop: 12 }
      }
    >
      <div
        style={{
          textAlign: 'center',
          fontSize: 14,
          fontWeight: 700,
          color: theme(dark).title,
          marginBottom: 4,
          flexShrink: 0,
        }}
      >
        {title}
      </div>
      <div style={fill ? { flex: 1, minHeight: 0 } : undefined}>
        <ResponsiveContainer width="100%" height={fill ? '100%' : height}>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Vertical (rotated 90°) tick for the log-frequency X axis (v3 minRotation/maxRotation = 90).
export function FreqTick({
  x,
  y,
  payload,
  fill,
}: {
  x?: number;
  y?: number;
  payload?: { value: number };
  fill?: string;
}) {
  const vx = x ?? 0;
  const vy = y ?? 0;
  return (
    <text
      x={vx}
      y={vy}
      dy={3}
      dx={-2}
      textAnchor="end"
      transform={`rotate(-90, ${vx}, ${vy})`}
      fontSize={12}
      fill={fill ?? THEME.light.ink}
    >
      {freqLabel(payload?.value ?? 0)}
    </text>
  );
}

/** An open ring on one series' point — the desktop's selection marker. */
function SelectionRing({
  x,
  y,
  color,
  yAxisId,
}: {
  x: number | null;
  y: number | null;
  color: string;
  yAxisId?: string;
}) {
  if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return (
    <ReferenceDot
      x={x}
      y={y}
      yAxisId={yAxisId}
      r={7}
      fill="none"
      stroke={color}
      strokeWidth={2}
      ifOverflow="visible"
    />
  );
}

function prep(data: ElectrodeData) {
  const keys = elecKeys(data);
  const inv = keys.length >= 22;
  const eMin = keys[0];
  const eMax = keys[keys.length - 1];
  const rows = keys.map((i) => ({
    elec: i,
    dist: data.min_dist[i] ?? null,
    angle: data.angle[i] ?? null,
    patient: data.min_freq[i] ?? null,
    mfr: data.c_freq[i] ?? null,
  }));
  const angleByFreq = keys
    .map((i) => ({ freq: data.min_freq[i], angle: data.angle[i] }))
    .filter((p) => p.freq != null && p.angle != null)
    .sort((a, b) => (a.freq as number) - (b.freq as number));
  return { keys, inv, eMin, eMax, eTicks: elecTicks(eMin, eMax), rows, angleByFreq };
}

/** The selected electrode's row, or null when nothing is selected / it has no data. */
function selRow(data: ElectrodeData, selectedLabel?: number | null) {
  if (selectedLabel == null) return null;
  const n = String(selectedLabel);
  if (!(n in data.location)) return null;
  return {
    elec: selectedLabel,
    dist: data.min_dist[n] ?? null,
    angle: data.angle[n] ?? null,
    patient: data.min_freq[n] ?? null,
    mfr: data.c_freq[n] ?? null,
  };
}

export function FreqMismatchChart({
  data,
  height = 384,
  dark,
  selectedLabel,
}: { data: ElectrodeData; height?: ChartHeight } & Themed) {
  const { inv, eMin, eMax, eTicks, rows } = prep(data);
  const t = theme(dark);
  const AX = { fontSize: 12, fill: t.ink };
  const sel = selRow(data, selectedLabel);
  return (
    <ChartCard title="Frequency-Place Mismatch" height={height} dark={dark}>
      <LineChart data={rows} margin={{ top: 24, right: 16, bottom: 24, left: 8 }}>
        <CartesianGrid stroke={t.grid} />
        <XAxis type="number" dataKey="elec" domain={[eMin, eMax]} ticks={eTicks} reversed={inv} tick={AX} tickLine={false}>
          <Label value="Electrode #" position="insideBottom" offset={-14} style={{ fontSize: 13, fill: t.title }} />
        </XAxis>
        <YAxis scale="log" domain={[FREQ_MIN, FREQ_MAX]} ticks={FREQ_TICKS} interval={0} tickFormatter={freqLabel} allowDataOverflow tick={AX} width={54}>
          <Label value="Frequency (Hz)" angle={-90} position="insideLeft" style={{ fontSize: 13, fill: t.title, textAnchor: 'middle' }} />
        </YAxis>
        <Tooltip formatter={oneDp} />
        <Legend verticalAlign="top" height={22} />
        <Line name="Patient" dataKey="patient" stroke={C.purple} dot={{ r: 3, fill: C.purple }} connectNulls={false} isAnimationActive={false} />
        <Line name="Manufacturer" dataKey="mfr" stroke={C.orange} dot={{ r: 3, fill: C.orange }} connectNulls={false} isAnimationActive={false} />
        {sel && <SelectionRing x={sel.elec} y={sel.patient} color={t.ring} />}
        {sel && <SelectionRing x={sel.elec} y={sel.mfr} color={t.ring} />}
      </LineChart>
    </ChartCard>
  );
}

export function AngleByFreqChart({
  data,
  height = 340,
  dark,
  selectedLabel,
}: { data: ElectrodeData; height?: ChartHeight } & Themed) {
  const { angleByFreq } = prep(data);
  const t = theme(dark);
  const AX = { fontSize: 12, fill: t.ink };
  const sel = selRow(data, selectedLabel);
  return (
    <ChartCard title="Electrodes Angle by Frequency" height={height} dark={dark}>
      <LineChart data={angleByFreq} margin={{ top: 12, right: 16, bottom: 40, left: 8 }}>
        <CartesianGrid stroke={t.grid} />
        <XAxis type="number" dataKey="freq" scale="log" domain={[FREQ_MIN, FREQ_MAX]} ticks={FREQ_TICKS} allowDataOverflow interval={0} height={56} tick={<FreqTick fill={t.ink} />}>
          <Label value="Frequency (Hz)" position="insideBottom" offset={-2} style={{ fontSize: 13, fill: t.title }} />
        </XAxis>
        <YAxis type="number" dataKey="angle" tick={AX} width={44}>
          <Label value="Angle (°)" angle={-90} position="insideLeft" style={{ fontSize: 13, fill: t.title, textAnchor: 'middle' }} />
        </YAxis>
        <Tooltip formatter={oneDp} />
        <Line dataKey="angle" stroke={C.blue} strokeWidth={1.5} dot={{ r: 4, fill: C.blue }} connectNulls={false} isAnimationActive={false} />
        {sel && <SelectionRing x={sel.patient} y={sel.angle} color={t.ring} />}
      </LineChart>
    </ChartCard>
  );
}

export function DistanceAngleChart({
  data,
  height = 320,
  dark,
  selectedLabel,
}: { data: ElectrodeData; height?: ChartHeight } & Themed) {
  const { inv, eMin, eMax, eTicks, rows } = prep(data);
  const t = theme(dark);
  const AX = { fontSize: 12, fill: t.ink };
  const sel = selRow(data, selectedLabel);
  return (
    <ChartCard title="Electrodes Distance / Angle" height={height} dark={dark}>
      <ComposedChart data={rows} margin={{ top: 24, right: 16, bottom: 24, left: 8 }}>
        <CartesianGrid stroke={t.grid} />
        <XAxis type="number" dataKey="elec" domain={[eMin, eMax]} ticks={eTicks} reversed={inv} tick={AX} tickLine={false}>
          <Label value="Electrode #" position="insideBottom" offset={-14} style={{ fontSize: 13, fill: t.title }} />
        </XAxis>
        <YAxis yAxisId="dist" domain={[0, 2]} ticks={[0, 0.5, 1, 1.5, 2]} tick={{ ...AX, fill: C.blue }} width={44}>
          <Label value="Distance (mm)" angle={-90} position="insideLeft" style={{ fontSize: 13, fill: C.blue, textAnchor: 'middle' }} />
        </YAxis>
        <YAxis yAxisId="angle" orientation="right" domain={[0, 'auto']} tickCount={5} tick={{ ...AX, fill: C.red }} width={44}>
          <Label value="Angle (°)" angle={90} position="insideRight" style={{ fontSize: 13, fill: C.red, textAnchor: 'middle' }} />
        </YAxis>
        <Tooltip formatter={oneDp} />
        <Legend verticalAlign="top" height={22} />
        <Area yAxisId="dist" name="Distance (mm)" dataKey="dist" stroke={C.blue} fill={C.blue} fillOpacity={0.15} dot={{ r: 3, fill: C.blue }} connectNulls={false} isAnimationActive={false} />
        <Line yAxisId="angle" name="Angle (°)" dataKey="angle" stroke={C.red} dot={{ r: 3, fill: C.red }} connectNulls={false} isAnimationActive={false} />
        {sel && <SelectionRing x={sel.elec} y={sel.dist} color={t.ring} yAxisId="dist" />}
        {sel && <SelectionRing x={sel.elec} y={sel.angle} color={t.ring} yAxisId="angle" />}
      </ComposedChart>
    </ChartCard>
  );
}

// Stacked composition for the Electrode Data tab (v3 order: mismatch, angle-by-freq, distance/angle).
export function ElectrodeCharts({ data, dark, selectedLabel }: { data: ElectrodeData } & Themed) {
  return (
    <div>
      <FreqMismatchChart data={data} dark={dark} selectedLabel={selectedLabel} />
      <AngleByFreqChart data={data} dark={dark} selectedLabel={selectedLabel} />
      <DistanceAngleChart data={data} dark={dark} selectedLabel={selectedLabel} />
    </div>
  );
}
