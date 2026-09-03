// Adapt the desktop's per-electrode series (projects.cip.electrode.figure_series) to the
// `ElectrodeData` shape the v3-ported charts already consume, so a loaded .cdb reuses
// charts/ElectrodeCharts.tsx (Frequency-Place Mismatch, Angle by Frequency, Distance/Angle)
// unchanged instead of growing a second set.
//
// The two sources agree on meaning, only on packaging: figure_series is parallel arrays in
// CONTACT-INDEX order, ElectrodeData is maps keyed by the electrode NUMBER.

import type { ElectrodeData, FigureSeries } from '../api/client';

const SCALA_NAMES: Record<number, string> = {
  0: 'Out of Cochlea',
  1: 'Scala Tympani',
  2: 'Scala Vestibuli',
  3: 'Basilar Membrane',
};

export function scalaName(code: number | null | undefined): string {
  return code == null ? '' : (SCALA_NAMES[code] ?? '');
}

/** Short scala tag for the compact table + the curves legend (the desktop's ST/SV/BM/OC). */
export function scalaTag(code: number | null | undefined): string {
  return code == null ? '' : (['OC', 'ST', 'SV', 'BM'][code] ?? '');
}

/**
 * `figure_series` (+ the table's scala codes) -> `ElectrodeData`.
 *
 * Only the fields the three charts read are populated: `min_dist`, `angle`, `min_freq` (patient
 * place frequency), `c_freq` (manufacturer channel frequency) and `location`. The curve fields
 * (`raw`, `curvefreqs`) belong to the v3 case format and stay empty — a .cdb's curves are the
 * distance-vs-angle family drawn by charts/CurvesGraph.tsx, which is a different plot.
 */
export function seriesToElectrodeData(
  series: FigureSeries | undefined,
  scala: (number | null)[] = [],
): ElectrodeData {
  const d: ElectrodeData = {
    raw: {},
    min_dist: {},
    angle: {},
    min_freq: {},
    c_freq: {},
    location: {},
    base: 0,
    electrode_type: 0,
    curvefreqs: [],
  };
  // A partial result (mid auto-process run) has no series yet — an empty chart, not a crash.
  (series?.label ?? []).forEach((label, i) => {
    const n = String(label);
    const put = (m: Record<string, number>, v: number | null | undefined) => {
      if (v != null && Number.isFinite(v)) m[n] = v;
    };
    put(d.min_dist, series!.distance[i]);
    put(d.angle, series!.angle[i]);
    put(d.min_freq, series!.place_freq[i]);
    put(d.c_freq, series!.channel_freq[i]);
    // `location` keys the charts' electrode set, so every electrode needs an entry even when its
    // scala is unknown — elecKeys() reads exactly this map.
    d.location[n] = scalaName(scala[i]) || 'Out of Cochlea';
  });
  return d;
}
