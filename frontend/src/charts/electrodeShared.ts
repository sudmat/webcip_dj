// Shared helpers for the electrode charts (port of v2 echarts-webtool.js).
import type { ElectrodeData } from '../api/client';

export const CHART_COLOR = {
  blue: '#3b82f6',
  red: '#ef4444',
  purple: '#8b5cf6',
  orange: '#f97316',
  green: '#10b981',
};

// v3 frequency axis: fixed log ticks + [500, 20000] domain, labels with thousands separators.
export const FREQ_MIN = 500;
export const FREQ_MAX = 20000;
export const FREQ_TICKS = [
  500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12500, 15000, 17500, 20000,
];
export const freqLabel = (v: number) => Number(v).toLocaleString();

// Shared chart height (Electrode Curves + ARO use the same figure height).
export const CHART_H = 460;

// v3 electrode-# axis: linear with stepSize 4 → ticks at every 4th electrode within range.
export function elecTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(min / 4) * 4; t <= max; t += 4) out.push(t);
  return out;
}

// v3 22-colour high-contrast palette (Google-Charts style) for the per-electrode curves.
export const ELECTRODE_PALETTE = [
  '#3366cc', '#dc3912', '#ff9900', '#109618', '#990099', '#0099c6',
  '#dd4477', '#66aa00', '#b82e2e', '#316395', '#994499', '#22aa99',
  '#aaaa11', '#6633cc', '#e67300', '#8b0707', '#651067', '#329262',
  '#5574a6', '#3b3eac', '#b77322', '#16d620',
];

export const LOCATION_STYLE: Record<string, { bg: string; fg: string }> = {
  'Scala Tympani': { bg: '#d1fae5', fg: '#065f46' },
  'Scala Vestibuli': { bg: '#fef3c7', fg: '#92400e' },
  'Out of Cochlea': { bg: '#fee2e2', fg: '#991b1b' },
  'Basilar Membrane': { bg: '#dcfce7', fg: '#14532d' },
};

/** Electrode numbers present, ascending (v2 keys). */
export function elecKeys(d: ElectrodeData): number[] {
  return Object.keys(d.location)
    .map(Number)
    .sort((a, b) => a - b);
}

export function meanDist(d: ElectrodeData): number {
  const vals = Object.values(d.min_dist).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/** Curves/ARO x-range (v3): frequencies where some electrode has data, clamped to [100, …]. */
export function curveXRange(d: ElectrodeData): { xMin: number; xMax: number } {
  const elec = Object.keys(d.raw).map(Number);
  const valid = d.curvefreqs.filter((_, fi) => elec.some((i) => d.raw[i][fi] !== -1));
  const rawMin = valid.length ? Math.min(...valid) : 100;
  const rawMax = valid.length ? Math.max(...valid) : 20000;
  return { xMin: Math.max(100, Math.floor(rawMin / 100) * 100), xMax: Math.ceil(rawMax / 100) * 100 };
}

/** ARO block for one electrode (v3 computeBlock): the freq span around the min-distance point where
 *  distance stays below yMin/√threshold. `pts` = [freq, dist] pairs (no -1 gaps). */
export function computeBlock(
  pts: [number, number][],
  threshold: number,
): { xLeft: number; xRight: number; xMin: number } | null {
  if (!pts.length) return null;
  let minIdx = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[minIdx][1]) minIdx = i;
  const xMin = pts[minIdx][0];
  const yThresh = pts[minIdx][1] / Math.sqrt(threshold);
  let li = minIdx;
  while (li > 0 && pts[li - 1][1] < yThresh) li--;
  let ri = minIdx;
  while (ri < pts.length - 1 && pts[ri + 1][1] < yThresh) ri++;
  return { xLeft: pts[li][0], xRight: pts[ri][0], xMin };
}

export const ARO_COLORS = {
  activeClean: '#22c55e',
  activeOverlap: '#f97316',
  inactiveClean: '#c084fc',
  inactiveOverlap: '#94a3b8',
};
