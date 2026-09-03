// ARO (Active Region Overlap) block plot — v3 renderARO, drawn as SVG (Recharts has no
// range-bar-on-log-axis). Layout matches v3: a left sidebar ("CHECK TO DEACTIVATE" checklist +
// threshold) beside the dark block chart, with the colour legend below. One horizontal bar per
// electrode spanning its active frequency block on a log-freq X, black centre tick at the
// min-distance freq, coloured by active/inactive × overlap.
import { useEffect, useRef, useState } from 'react';
import type { ElectrodeData } from '../api/client';
import { FREQ_TICKS, freqLabel, curveXRange, computeBlock, ARO_COLORS, CHART_H } from './electrodeShared';

const SIDEBAR_W = 152;
const M = { left: 42, right: 26, top: 28, bottom: 40 };
const CHART_HEIGHT = CHART_H - 100; // shorter than the curves so the whole section fits beside it
const X_LABELS = [1000, 2000, 5000, 10000]; // sparse labels (gridlines still drawn for all ticks)

export function AroPanel({
  data,
  active,
  onToggle,
  threshold,
  setThreshold,
}: {
  data: ElectrodeData;
  active: Set<number>;
  onToggle: (elec: number) => void;
  threshold: number;
  setThreshold: (t: number) => void;
}) {
  const elec = Object.keys(data.raw)
    .map(Number)
    .sort((a, b) => a - b);
  const freqs = data.curvefreqs;
  const { xMin, xMax } = curveXRange(data);
  const logMin = Math.log(xMin);
  const logMax = Math.log(xMax);

  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(420);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const H = CHART_HEIGHT;
  const plotW = Math.max(40, W - M.left - M.right);
  const plotH = H - M.top - M.bottom;
  const rowH = plotH / elec.length;
  const barH = Math.min(rowH * 0.82, 12);
  const xOf = (f: number) => M.left + ((Math.log(f) - logMin) / (logMax - logMin)) * plotW;
  const rowY = (num: number) => M.top + (elec.length - 1 - elec.indexOf(num) + 0.5) * rowH;

  const blocks = elec
    .map((num) => {
      const pts = freqs
        .map((f, fi): [number, number] | null => (data.raw[num][fi] === -1 ? null : [f, data.raw[num][fi]]))
        .filter((p): p is [number, number] => p !== null);
      const b = computeBlock(pts, threshold);
      return b ? { num, ...b } : null;
    })
    .filter((b): b is { num: number; xLeft: number; xRight: number; xMin: number } => b !== null);

  const activeCenters = blocks.filter((b) => active.has(b.num)).map((b) => ({ num: b.num, xMin: b.xMin }));
  const colorFor = (b: { num: number; xLeft: number; xRight: number }) => {
    const isActive = active.has(b.num);
    const overlaps = activeCenters.some((c) => c.num !== b.num && c.xMin >= b.xLeft && c.xMin <= b.xRight);
    return isActive
      ? overlaps
        ? ARO_COLORS.activeOverlap
        : ARO_COLORS.activeClean
      : overlaps
        ? ARO_COLORS.inactiveOverlap
        : ARO_COLORS.inactiveClean;
  };

  const gridTicks = FREQ_TICKS.filter((v) => v >= xMin && v <= xMax);
  const labelTicks = [...new Set([xMin, ...X_LABELS.filter((v) => v > xMin && v < xMax), xMax])];

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {/* left: deactivate checklist + threshold */}
        <div style={{ width: SIDEBAR_W, flexShrink: 0, fontSize: 11, color: '#475569' }}>
          <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 4, color: '#334155' }}>CHECK TO DEACTIVATE</div>
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 15 * 16, overflowY: 'auto' }}>
            {[...elec].reverse().map((num) => (
              <label key={num} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', lineHeight: 1.15, flexShrink: 0 }}>
                <input type="checkbox" checked={!active.has(num)} onChange={() => onToggle(num)} style={{ width: 12, height: 12 }} />
                Electrode {num}
              </label>
            ))}
          </div>
          <div style={{ fontWeight: 700, marginTop: 10, color: '#334155' }}>THRESHOLD: {threshold.toFixed(2)}</div>
          <input type="range" min={0.1} max={1} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: '100%' }} />
        </div>

        {/* right: dark block chart */}
        <div ref={ref} style={{ flex: 1, minWidth: 0, background: '#0f172a', borderRadius: 6 }}>
          <svg width={W} height={H} style={{ display: 'block' }}>
            <text x={M.left + plotW / 2} y={16} textAnchor="middle" fill="#e2e8f0" fontSize={14} fontWeight={600}>
              Active Region Overlap
            </text>
            <text x={4} y={M.top - 8} fill="#94a3b8" fontSize={12}>
              Electrode
            </text>
            {gridTicks.map((f) => (
              <line key={f} x1={xOf(f)} y1={M.top} x2={xOf(f)} y2={M.top + plotH} stroke="#1e293b" />
            ))}
            {labelTicks.map((f) => (
              <text key={f} x={xOf(f)} y={M.top + plotH + 15} textAnchor="middle" fill="#94a3b8" fontSize={12}>
                {freqLabel(f)}
              </text>
            ))}
            <text x={M.left + plotW / 2} y={H - 6} textAnchor="middle" fill="#94a3b8" fontSize={12}>
              Frequency (Hz)
            </text>
            {/* y labels: every other electrode (odd), like v3 */}
            {elec
              .filter((n) => n % 2 === 1)
              .map((num) => (
                <text key={num} x={M.left - 6} y={rowY(num) + 4} textAnchor="end" fill="#94a3b8" fontSize={12}>
                  {num}
                </text>
              ))}
            {blocks.map((b) => {
              const yc = rowY(b.num);
              const x0 = xOf(b.xLeft);
              const x1 = xOf(b.xRight);
              return (
                <g key={b.num} style={{ cursor: 'pointer' }} onClick={() => onToggle(b.num)}>
                  <rect x={Math.min(x0, x1)} y={yc - barH / 2} width={Math.max(2, Math.abs(x1 - x0))} height={barH} fill={colorFor(b)} opacity={0.92} />
                  <line x1={xOf(b.xMin)} y1={yc - barH / 2} x2={xOf(b.xMin)} y2={yc + barH / 2} stroke="#000" strokeWidth={2} />
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* colour legend (v3) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 16px', marginTop: 8, fontSize: 11, color: '#334155' }}>
        {(
          [
            [ARO_COLORS.activeClean, 'Activated Electrode'],
            [ARO_COLORS.activeOverlap, 'Interacting Electrodes'],
            [ARO_COLORS.inactiveOverlap, 'Deactivated Electrode'],
            [ARO_COLORS.inactiveClean, 'Electrode Can Be Activated Without Interaction'],
          ] as [string, string][]
        ).map(([c, label]) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, background: c, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
