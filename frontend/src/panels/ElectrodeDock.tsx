import { useEffect, useMemo, useState } from 'react';
import {
  fetchGraphSeries,
  fetchMipPoints,
  mipUrl,
  type CdbElectrodes,
  type GraphSeries,
  type MipPoints,
} from '../api/client';
import { seriesToElectrodeData } from '../core/electrodeData';
import { CurvesGraph } from '../charts/CurvesGraph';
import { AngleByFreqChart, DistanceAngleChart, FreqMismatchChart } from '../charts/ElectrodeCharts';
import { MipView } from '../charts/MipView';
import type { ViewerController } from '../render/viewerController';
import { useControllerTick } from './ui';

// The postop electrode-analysis dock — a port of desktop/electrode_panel.py::ElectrodePanel.
// Tabs: the interactive IDL Curves graph, the MIP projection, and the three analysis figures
// (which reuse the existing recharts components via core/electrodeData's adapter).
//
// A .cdb opens READ-ONLY, so every clinician edit the desktop offers here — double-click on/off,
// the right-click scala/angle/deactivate menu, Reset and Re-segment — is disabled, exactly as
// electrode_panel._edits_locked does.

export type Tab = 'curves' | 'mip' | 'mismatch' | 'anglefreq' | 'distangle';

const TABS: { id: Tab; label: string }[] = [
  { id: 'curves', label: 'Curves' },
  { id: 'mip', label: 'MIP-projection' },
  { id: 'mismatch', label: 'Freq-Place Mismatch' },
  { id: 'anglefreq', label: 'Angle by Freq' },
  { id: 'distangle', label: 'Distance/Angle' },
];

export function ElectrodeDock({
  controller,
  cdbId,
  electrodes,
  tab: tabProp,
  onTab,
}: {
  controller: ViewerController;
  cdbId: string;
  electrodes: CdbElectrodes;
  /** Which tab is in front, when something outside drives it — a takeover panel putting the
   *  MIP up, as the desktop's _open_electrode_panel(ctx, mip=True) does. Omit both props and
   *  the dock owns its own tab, which is what every ordinary use wants. */
  tab?: Tab;
  onTab?: (t: Tab) => void;
}) {
  useControllerTick(controller);
  const [ownTab, setOwnTab] = useState<Tab>('curves');
  const tab = tabProp ?? ownTab;
  const setTab = (t: Tab) => (onTab ? onTab(t) : setOwnTab(t));
  const [setting, setSetting] = useState(electrodes.cur_setting);
  const [graph, setGraph] = useState<GraphSeries | null>(null);
  const [scrub, setScrub] = useState(0); // 0..1000 over the centerline angles
  const [mip, setMip] = useState<MipPoints | null>(null);

  // The graph series is per activation setting — refetch when it changes.
  useEffect(() => {
    let live = true;
    fetchGraphSeries(cdbId, setting)
      .then((g) => live && setGraph(g))
      .catch(() => live && setGraph(null));
    return () => {
      live = false;
    };
  }, [cdbId, setting]);

  useEffect(() => {
    let live = true;
    fetchMipPoints(cdbId)
      .then((p) => live && setMip(p))
      .catch(() => live && setMip(null));
    return () => {
      live = false;
    };
  }, [cdbId]);

  // The scrub slider runs over the centerline angles (desktop _GraphTab._angle_at).
  const angles = graph?.cl_cangles ?? [];
  const cursorAngle = useMemo(() => {
    if (!angles.length) return null;
    const lo = Math.min(...angles);
    const hi = Math.max(...angles);
    return lo + (scrub / 1000) * (hi - lo);
  }, [angles, scrub]);

  // The three analysis charts read the v3 ElectrodeData shape; adapt figure_series to it.
  const chartData = useMemo(
    () => seriesToElectrodeData(electrodes.series, electrodes.rows.map((r) => r.scala)),
    [electrodes],
  );

  const selected = controller.selectedElectrode;
  const hasCenterline = Boolean(graph?.cl_coords?.length && graph?.cl_cangles?.length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 2, padding: '4px 6px 0', flexShrink: 0 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              borderRadius: '4px 4px 0 0',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              background: tab === t.id ? 'var(--control-hover)' : 'transparent',
              fontWeight: tab === t.id ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'curves' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', flexShrink: 0 }}>
          <span style={{ color: 'var(--muted)' }}>Activation:</span>
          <select value={setting} onChange={(e) => setSetting(Number(e.target.value))} style={{ minWidth: 220 }}>
            {electrodes.settings.map((name, i) => (
              <option key={i} value={i}>
                {name}
              </option>
            ))}
          </select>
          {/* Read-only .cdb: the clinician actions the desktop offers are shown, disabled. */}
          <button disabled title="Read-only .cdb view — electrode edits are disabled">
            Reset
          </button>
          <button
            disabled
            title="Not ported: the C-view needs an oblique reslice orientation the web viewer does not have yet"
          >
            Center line view
          </button>
          <button disabled title="Read-only .cdb view — re-segmentation is disabled">
            Re-segment
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ color: 'var(--muted)' }}>Center line:</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={scrub}
            disabled={!hasCenterline}
            onChange={(e) => setScrub(Number(e.target.value))}
            title="Scrub the cochlear angle along the centerline"
            style={{ width: 260 }}
          />
          <span style={{ color: 'var(--muted)', width: 44, textAlign: 'right' }}>
            {cursorAngle != null ? `${Math.round(cursorAngle)}°` : '—'}
          </span>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'curves' && (
          <CurvesGraph
            series={graph}
            cursorAngle={cursorAngle}
            selectedLabel={selected}
            onSelect={(l) => controller.selectElectrode(l)}
          />
        )}
        {tab === 'mip' && (
          <MipView
            src={mipUrl(cdbId)}
            points={mip}
            selectedLabel={selected}
            onSelect={(l) => controller.selectElectrode(l)}
          />
        )}
        {/* dark: this dock is dark, unlike the Display workspace's white chart panel. The rings
            follow the same selection the Curves graph, the table and the MIP share. */}
        {/* height="100%": the dock is user-resizable, so the chart grows with it rather than
            sitting at a fixed height with dead space (or a scrollbar) around it. */}
        {tab === 'mismatch' && <FreqMismatchChart data={chartData} height="100%" dark selectedLabel={selected} />}
        {tab === 'anglefreq' && <AngleByFreqChart data={chartData} height="100%" dark selectedLabel={selected} />}
        {tab === 'distangle' && <DistanceAngleChart data={chartData} height="100%" dark selectedLabel={selected} />}
      </div>
    </div>
  );
}
