import { useEffect, useRef, useState } from 'react';
import {
  fetchConfig,
  fetchOpenable,
  fetchCurves,
  fetchMesh,
  fetchMeshManifest,
  fetchVolume,
  loadCase,
  type ElectrodeData,
  type OpenableItem,
} from '../api/client';
import { Image } from '../core/image';
import { makeStructure, type Structure, type MeshGroup } from '../core/structure';
import { useScenePanes } from '../render/useScenePanes';
import { ViewerController } from '../render/viewerController';
import { useControllerTick } from '../panels/ui';
import { OVERLAY_METHODS } from '../render/overlay';
import type { ViewName } from '../core/scene';
import { ElectrodePanel } from '../charts/ElectrodePanel';
import { CurvesTab } from '../charts/CurvesTab';
import { PdfPanel } from '../charts/PdfPanel';
import { AppShell } from '../layout/AppShell';

type Tab = 'display' | 'electrode-curves' | 'electrode-data' | 'pdf';

// Result-display workspace: 3D view large on top, three small MPR panes below, a left
// sidebar (case load + structure list). Layout follows the musc-analytics v2 display page.
const SMALL_VIEWS: ViewName[] = ['axial', 'sagittal', 'coronal'];

export function DisplayApp() {
  const controllerRef = useRef<ViewerController>(new ViewerController());
  const controller = controllerRef.current;
  const hostRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const host3dRef = useRef<HTMLDivElement>(null);
  const [folder, setFolder] = useState('');   // filled from GET /api/config
  const [status, setStatus] = useState('Load a case folder.');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('display');
  const [curves, setCurves] = useState<ElectrodeData | null>(null);
  const [caseTitle, setCaseTitle] = useState('');

  // What this server already has that can be displayed WITHOUT running the pipeline. The
  // desktop's equivalent is a file dialog; typing an absolute path from memory is not, so the
  // server lists what it found under its data roots and the box becomes a picker.
  const [cases, setCases] = useState<OpenableItem[]>([]);
  useEffect(() => {
    fetchOpenable()
      .then((o) => {
        setCases(o.cases);
        // Pre-select the only case, or the server's declared default. With several, leave the
        // choice to the user rather than guessing.
        if (o.cases.length === 1) setFolder(o.cases[0].path);
      })
      .catch(() => {});
    fetchConfig()
      .then(({ defaults }) => defaults.case && setFolder(defaults.case))
      .catch(() => {});
  }, []);

  // v2 resizeScene: chart tabs widen the left panel and narrow the 3D area — re-render the vtk
  // views once the new widths have laid out.
  useEffect(() => {
    const id = requestAnimationFrame(() => controller.refresh());
    return () => cancelAnimationFrame(id);
  }, [tab, controller]);

  useScenePanes(controller, hostRefs, host3dRef, SMALL_VIEWS, {
    compact: true,
    displayView: true,
    sliceByVoxel: true, // wheel advances 1 image slice, not vs.sliceStep
  });

  async function onLoad() {
    setBusy(true);
    setStatus('loading case…');
    try {
      const cd = await loadCase(folder);
      const img = new Image(cd.image);
      const { pixels } = await fetchVolume(cd.imageId);
      img.pixels = pixels;
      controller.set3dMode('none'); // 3D shows meshes, not a CT volume/surface
      // fit the 2D FOV to the crop (it's small vs the default 256 mm)
      controller.scene.view.fovMm = Math.max(...img.size.map((s, i) => s * img.spacing[i])) * 1.15;
      controller.addImage(img);
      setStatus('loading meshes…');
      const structs: Structure[] = [];
      for (const group of ['structures', 'implants'] as MeshGroup[]) {
        const manifest = await fetchMeshManifest(cd.caseId, group);
        const meshes = await Promise.all(
          manifest.map((it) => fetchMesh(cd.caseId, group, it.index, it.n_points, it.n_tris)),
        );
        manifest.forEach((it, i) => structs.push(makeStructure(group, it, meshes[i])));
      }
      controller.setStructures(structs);
      setCaseTitle(`${cd.meta.plan_id} ${cd.meta.side}`);
      try {
        setCurves(await fetchCurves(cd.caseId));
      } catch {
        setCurves(null); // some cases have no electrode curves
      }
      setStatus(`${cd.meta.plan_id} ${cd.meta.side} — ${structs.length} meshes`);
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const smallCell: React.CSSProperties = {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    border: '1px solid #000',
    background: '#000',
  };

  const onCharts = tab !== 'display';
  return (
    // Left region: case load + tabs. Tabs switch the LEFT content only (v2); the 3D/MPR stays
    // mounted and visible on every tab. v2 widens the panel to ~45% for the chart tabs so they get
    // room and the 3D/MPR narrows to fit; the Display tab keeps it narrow.
    <AppShell
      storageKey="display"
      left={{
        // Called, not mounted as <LeftPanel/>: a component declared inside the render body is a new
        // component TYPE every render, which remounts the subtree and drops input focus mid-typing.
        content: leftPanel(),
        size: onCharts ? Math.round(window.innerWidth * 0.45) : 380,
        min: 280,
      }}
    >
      {/* 3D large on top, the three MPR panes below — a 70/30 split as flex GROW, not height
          percentages: a percentage needs a definite parent height, which a flex chain does not
          provide, and the vtk host then sizes itself to its content (a 1200px square). */}
      <div
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#000' }}
      >
        <div style={{ flex: '7 1 0', minHeight: 0 }}>
          <div ref={host3dRef} style={{ width: '100%', height: '100%' }} />
        </div>
        <div style={{ flex: '3 1 0', minHeight: 0, display: 'flex', gap: 2 }}>
          {SMALL_VIEWS.map((v, i) => (
            <div key={v} style={smallCell}>
              <div ref={hostRefs[i]} style={{ width: '100%', height: '100%' }} />
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );

  function leftPanel() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: 10, borderBottom: '1px solid var(--panel-border)' }}>
          {cases.length > 0 && (
            <select
              style={{ width: '100%', marginBottom: 6 }}
              value={cases.some((c) => c.path === folder) ? folder : ''}
              onChange={(e) => e.target.value && setFolder(e.target.value)}
              title="Result folders found under this server's data roots"
            >
              <option value="">— choose a result folder —</option>
              {cases.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <input
            style={{ width: '100%', marginBottom: 6 }}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="or a server path to a case folder"
            title={folder}
          />
          <button onClick={onLoad} disabled={busy || !folder.trim()} style={{ width: '100%' }}>
            Load case
          </button>
          <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 'var(--fs-sm)' }}>{status}</div>
        </div>
        <TabBar tab={tab} setTab={setTab} hasCurves={curves !== null} />
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: onCharts ? 14 : 10,
            background: onCharts ? '#fff' : 'transparent',
            color: onCharts ? '#334155' : undefined,
          }}
        >
          {tab === 'display' && (
            <>
              <SliceSliders controller={controller} />
              <CtControls controller={controller} />
              <OverlayMethodControl controller={controller} />
              <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, margin: '10px 0 4px', color: 'var(--muted)' }}>
                Structures <span style={{ fontWeight: 400 }}>(3D · 2D · opacity)</span>
              </div>
              <StructureList controller={controller} />
            </>
          )}
          {tab === 'electrode-data' &&
            (curves ? <ElectrodePanel data={curves} /> : <div>No electrode data for this case.</div>)}
          {tab === 'electrode-curves' &&
            (curves ? <CurvesTab data={curves} /> : <div>No electrode curves for this case.</div>)}
          {tab === 'pdf' &&
            (curves ? (
              <PdfPanel data={curves} controller={controller} title={caseTitle} />
            ) : (
              <div>No electrode data to report.</div>
            ))}
        </div>
      </div>
    );
  }
}

// Left-panel tabs (v2 postop: Display / Electrode Curves / Electrode Data / PDF). Switching a tab
// changes the LEFT content only; the 3D + MPR view on the right stays put.
function TabBar({ tab, setTab, hasCurves }: { tab: Tab; setTab: (t: Tab) => void; hasCurves: boolean }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'display', label: 'Display' },
    { id: 'electrode-curves', label: 'Curves' },
    { id: 'electrode-data', label: 'Electrode Data' },
    { id: 'pdf', label: 'PDF' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: '4px 6px 0',
        background: 'var(--panel)',
        borderBottom: '1px solid var(--panel-border)',
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const active = tab === t.id;
        const disabled = t.id !== 'display' && !hasCurves;
        return (
          <button
            key={t.id}
            onClick={() => !disabled && setTab(t.id)}
            disabled={disabled}
            style={{
              padding: '5px 10px',
              fontSize: 'var(--fs-sm)',
              border: 'none',
              borderRadius: '4px 4px 0 0',
              cursor: disabled ? 'default' : 'pointer',
              background: active ? '#fff' : 'transparent',
              color: active ? '#111' : disabled ? 'var(--faint)' : 'var(--muted)',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Per-pane slice index sliders (v2 initIndexCtrl): move the crosshair along each view normal.
function SliceSliders({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  if (!controller.image) return null;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' };
  const lab: React.CSSProperties = { width: '4.5em', fontSize: 'var(--fs-sm)', color: 'var(--muted)', textTransform: 'capitalize' };
  return (
    <div>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 4, color: 'var(--muted)' }}>Slice</div>
      {SMALL_VIEWS.map((v) => {
        const info = controller.sliceInfo(v);
        if (!info) return null;
        return (
          <div key={v} style={row}>
            <span style={lab}>{v}</span>
            <input
              type="range"
              min={0}
              max={info.max}
              step={1}
              value={info.index}
              onChange={(e) => controller.setSliceIndex(v, Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ width: '3.4em', textAlign: 'right', fontSize: 'var(--fs-xs)' }}>
              {info.index}/{info.max}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Structure list (D4): 3D-show · 2D-show · color swatch · name · opacity.
function StructureList({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const structs = controller.structures;
  useEffect(() => {}, [structs.length]);
  if (!structs.length) return <div style={{ color: 'var(--muted)' }}>No structures loaded.</div>;
  return (
    <div>
      {structs.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
          <input
            type="checkbox"
            title="Show in 3D"
            checked={s.visible}
            onChange={(e) => controller.updateStructure(s.id, { visible: e.target.checked })}
          />
          <input
            type="checkbox"
            title="Show in 2D panes"
            checked={s.visible2d}
            onChange={(e) => controller.updateStructure(s.id, { visible2d: e.target.checked })}
          />
          <span
            style={{
              width: 12,
              height: 12,
              background: `rgb(${s.color.map((c) => Math.round(c * 255)).join(',')})`,
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.label}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={s.opacity}
            title="Opacity"
            onChange={(e) => controller.updateStructure(s.id, { opacity: Number(e.target.value) })}
            style={{ width: 60 }}
          />
        </div>
      ))}
    </div>
  );
}

// 2D structure-overlay technique switch (mesh-projection / contour / mask). Radio: methods are
// mutually exclusive and apply to all three MPR panes at once.
function OverlayMethodControl({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const cur = controller.overlayMethod;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 4, color: 'var(--muted)' }}>2D overlay</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {OVERLAY_METHODS.map((m) => (
          <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-sm)', cursor: 'pointer' }}>
            <input
              type="radio"
              name="overlay-method"
              checked={cur === m.id}
              onChange={() => controller.setOverlayMethod(m.id)}
            />
            {m.label}
          </label>
        ))}
      </div>
    </div>
  );
}

// CT window/level (contrast/intensity) sliders — the v2 display contrast + intensity controls.
function CtControls({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const img = controller.image;
  if (!img) return null;
  const span = Math.max(img.valueMax - img.valueMin, 1);
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' };
  const lab: React.CSSProperties = { width: '4.5em', fontSize: 'var(--fs-sm)', color: 'var(--muted)' };
  return (
    <div>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 4, color: 'var(--muted)' }}>CT window</div>
      <div style={row}>
        <span style={lab}>Level</span>
        <input
          type="range"
          min={img.valueMin}
          max={img.valueMax}
          step={span / 400}
          value={img.level}
          onChange={(e) => controller.setContrast(Number(e.target.value), img.window)}
          style={{ flex: 1 }}
        />
        <span style={{ width: '3.4em', textAlign: 'right', fontSize: 'var(--fs-xs)' }}>{img.level.toFixed(0)}</span>
      </div>
      <div style={row}>
        <span style={lab}>Window</span>
        <input
          type="range"
          min={1}
          max={span}
          step={span / 400}
          value={img.window}
          onChange={(e) => controller.setContrast(img.level, Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ width: '3.4em', textAlign: 'right', fontSize: 'var(--fs-xs)' }}>{img.window.toFixed(0)}</span>
      </div>
      <button
        style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}
        onClick={() => controller.setContrast(img.autoLevel, img.autoWindow)}
      >
        Auto W/L
      </button>
    </div>
  );
}
