import { useEffect, useState } from 'react';
import type { MeshMode2D, ViewerController } from '../render/viewerController';
import type { Mode3D } from '../render/View3D';
import { fetchColormap, fetchColormapNames } from '../api/client';
import { SLICE_STEPS } from '../core/scene';
import { Check, Group, Labeled, useControllerTick } from './ui';

// The desktop's "2D meshes" modes (four_up_viewer.set_contour_mode).
const MESH_MODES: { id: MeshMode2D; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'contour', label: 'Contour' },
  { id: 'transparent', label: 'Transparent' },
  { id: 'solid', label: 'Solid' },
];

// CT window/level presets (pv_core/contrast.py).
const CONTRAST: Record<string, [number, number]> = {
  Bone: [350, 2000], // [level, window]
  'Soft tissue': [40, 400],
  Lung: [-600, 1500],
  Brain: [40, 80],
};

export function Display({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const [cmapNames, setCmapNames] = useState<string[]>([]);
  const [editSlot, setEditSlot] = useState<'top' | 'bottom'>('top');
  const [nav, setNav] = useState(true);

  useEffect(() => {
    fetchColormapNames()
      .then(setCmapNames)
      .catch(() => setCmapNames([]));
  }, []);

  const images = controller.scene.images;
  const byId = (id: string) => images.find((im) => im.id === id) ?? null;
  // A takeover panel drives which images are shown (the desktop's set_slots_enabled(False)),
  // so the slot selects are frozen while one is open.
  const slotsLocked = controller.viewLocked;
  const hasBottom = controller.scene.bottom !== null;
  // The image the per-image controls (interpolation / colormap / contrast) act on.
  const target =
    editSlot === 'bottom' && controller.scene.bottom ? controller.scene.bottom : controller.scene.top;

  const onCmap = async (idx: number) => {
    if (idx === 0) controller.setColormap(null, 0, target); // B-W LINEAR == grayscale
    else controller.setColormap(await fetchColormap(idx), idx, target);
  };
  const onContrast = (name: string) => {
    if (!target) return;
    if (name === 'Auto') controller.setContrast(target.autoLevel, target.autoWindow, target);
    else if (name === 'Header' && target.headerLevel != null && target.headerWindow != null)
      controller.setContrast(target.headerLevel, target.headerWindow, target);
    else if (CONTRAST[name]) controller.setContrast(CONTRAST[name][0], CONTRAST[name][1], target);
  };

  const sel: React.CSSProperties = { flex: 1, minWidth: 0 };

  return (
    <Group title="Display">
      <Labeled label="Top">
        <select
          style={sel}
          value={controller.scene.top?.id ?? ''}
          disabled={!images.length || slotsLocked}
          onChange={(e) => {
            const im = byId(e.target.value);
            if (im) controller.selectTop(im);
          }}
        >
          {images.length ? (
            images.map((im) => (
              <option key={im.id} value={im.id}>
                {im.name}
              </option>
            ))
          ) : (
            <option>—</option>
          )}
        </select>
      </Labeled>

      <Labeled label="Bottom">
        <select
          style={sel}
          value={controller.scene.bottom?.id ?? ''}
          disabled={!images.length || slotsLocked}
          onChange={(e) => controller.selectBottom(byId(e.target.value))}
        >
          <option value="">(none)</option>
          {images
            .filter((im) => im !== controller.scene.top)
            .map((im) => (
              <option key={im.id} value={im.id}>
                {im.name}
              </option>
            ))}
        </select>
      </Labeled>

      {/* Which image the per-image settings below act on (only relevant when blending). */}
      {hasBottom && (
        <Labeled label="Settings for">
          <select
            style={sel}
            value={editSlot}
            onChange={(e) => setEditSlot(e.target.value as 'top' | 'bottom')}
          >
            <option value="top">Top — {controller.scene.top?.name}</option>
            <option value="bottom">Bottom — {controller.scene.bottom?.name}</option>
          </select>
        </Labeled>
      )}

      <Labeled label="Interpolation">
        <select
          style={sel}
          value={target?.interp ?? 'linear'}
          disabled={!target}
          onChange={(e) => controller.setInterpolation(e.target.value as 'linear' | 'nearest', target)}
        >
          <option value="linear">Linear</option>
          <option value="nearest">Nearest</option>
        </select>
      </Labeled>

      <Labeled label="Colormap">
        <select
          style={sel}
          value={target?.colormapIndex ?? 0}
          onChange={(e) => onCmap(Number(e.target.value))}
          disabled={!cmapNames.length || !target}
        >
          {cmapNames.map((n, i) => (
            <option key={i} value={i}>
              {n || `Scheme ${i}`}
            </option>
          ))}
        </select>
      </Labeled>

      <Labeled label="Contrast">
        <select
          style={sel}
          value=""
          disabled={!target}
          onChange={(e) => onContrast(e.target.value)}
        >
          <option value="" disabled>
            choose…
          </option>
          <option>Auto</option>
          {target?.headerLevel != null && <option>Header</option>}
          {Object.keys(CONTRAST).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </Labeled>

      <Labeled label="3D rendering">
        <select
          style={sel}
          value={controller.mode3d}
          onChange={(e) => controller.set3dMode(e.target.value as Mode3D)}
        >
          <option value="volume">Volume</option>
          <option value="surface">Surface</option>
          <option value="mip">MIP</option>
          <option value="none">None</option>
        </select>
      </Labeled>

      <Labeled label="3D projection">
        <select
          style={sel}
          value={controller.projection3d}
          onChange={(e) => controller.set3dProjection(e.target.value as 'parallel' | 'perspective')}
        >
          <option value="perspective">Perspective</option>
          <option value="parallel">Parallel</option>
        </select>
      </Labeled>

      <Labeled label="2D meshes">
        <select
          style={sel}
          value={controller.meshMode2d}
          onChange={(e) => controller.setMeshMode2d(e.target.value as MeshMode2D)}
        >
          {MESH_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Labeled>

      <Labeled label="Slicing step">
        <select
          style={sel}
          value={controller.scene.view.sliceStep}
          onChange={(e) => controller.setSliceStep(Number(e.target.value))}
        >
          {SLICE_STEPS.map((s) => (
            <option key={s} value={s}>
              {s} mm
            </option>
          ))}
        </select>
      </Labeled>

      <Check
        label="Reference line"
        checked={controller.referenceLine}
        onChange={(v) => controller.setReferenceLine(v)}
      />
      <Check
        label="Navigation control"
        checked={nav}
        onChange={(v) => {
          setNav(v);
          controller.setNavigationControl(v);
        }}
      />
      <Check
        label="Anatomic convention"
        checked={!controller.scene.view.radiological}
        onChange={(v) => controller.setRadiological(!v)}
      />
      <Check label="Annotation" checked={controller.annotationOn} onChange={(v) => controller.setAnnotation(v)} />
      <Check
        label="Point projection"
        checked={controller.pointProjection}
        onChange={(v) => controller.setPointProjection(v)}
      />
    </Group>
  );
}
