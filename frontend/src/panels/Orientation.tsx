import type { ViewerController } from '../render/viewerController';
import { Group, useControllerTick } from './ui';

// Desktop Orientation panel. "Original" slices along the world axes; "Primary" along the primary
// image's own grid planes (the desktop's "2D orientation: Primary", its postop default) — the two
// differ only when the primary image is placed off the world axes, which for us means a loaded
// .cdb (its pair is re-framed onto the atlas).
//
// AC/PC and Trajectory need an oblique reslice frame the viewer does not have yet — the same gap
// that defers the electrode panel's "Center line view".
export function Orientation({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const mode = controller.orientationMode;
  const opt = (id: string, label: string, disabled = false, onPick?: () => void) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: disabled ? 0.5 : 1 }}>
      <input
        type="radio"
        name="orientation"
        checked={mode === id}
        disabled={disabled}
        onChange={() => onPick?.()}
      />
      {label}
    </label>
  );
  return (
    <Group title="Orientation">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {opt('primary', 'Primary', false, () => controller.setOrientationMode('primary'))}
        {opt('original', 'Original', false, () => controller.setOrientationMode('original'))}
        {opt('acpc', 'AC/PC', true)}
        {opt('traj', 'Trajectory', true)}
      </div>
    </Group>
  );
}
