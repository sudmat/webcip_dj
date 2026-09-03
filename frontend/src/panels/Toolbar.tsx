import type { ViewerController } from '../render/viewerController';
import type { Tool2D } from '../render/ReslicePane';
import { asset } from '../api/paths';
import { useControllerTick } from './ui';

// The 2D tool toolbar (desktop main.py). Exclusive icon tools; register shows
// Undo/Redo/Clear + an atlas-scale toggle for the moving (bottom) image.
const TOOLS: { id: Tool2D; label: string; tip: string }[] = [
  { id: 'position', label: 'Position', tip: 'Position — L: crosshair (×2 center) · R: W/L (×2 reset) · M: pan · wheel: slice' },
  { id: 'overlay', label: 'Overlay', tip: 'Overlay — L: checkerboard · R: patch (needs a bottom image)' },
  { id: 'measure', label: 'Measure', tip: 'Measure — L: distance · R: angle · Ctrl+L: ortho · L×2: clear' },
  { id: 'crop', label: 'Crop', tip: 'Crop — L: crop / fg-low (×2 reset) · R: fg-high (×2 reset)' },
  { id: 'register', label: 'Register', tip: 'Register — L: translate · R: rotate · M: scale (atlas) · L×2: pivot' },
];

export function Toolbar({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const active = controller.tool;
  const hasBottom = controller.scene.bottom !== null;

  const btn = (id: Tool2D, label: string, tip: string) => (
    <button
      key={id}
      title={tip}
      aria-label={label}
      onClick={() => controller.setTool(id)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 28,
        padding: 0,
        background: active === id ? 'var(--accent)' : 'var(--control-bg)',
        borderColor: active === id ? 'var(--accent)' : 'var(--panel-border)',
        color: active === id ? 'var(--accent-text)' : 'var(--text)',
      }}
    >
      <img
        src={asset(`icons/${id}.png`)}
        alt={label}
        width={20}
        height={20}
        style={{ filter: 'brightness(0) invert(1)' }} // dark silhouette -> white for the dark toolbar
      />
    </button>
  );

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '6px 12px',
        borderBottom: '1px solid var(--panel-border)',
        background: 'var(--panel)',
      }}
    >
      <span style={{ color: 'var(--muted)', marginRight: 4 }}>2D tools:</span>
      {TOOLS.map((t) => btn(t.id, t.label, t.tip))}

      {active === 'register' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 12 }}>
          <button disabled={!hasBottom} onClick={() => controller.regUndo()} title="Undo registration step">
            Undo
          </button>
          <button disabled={!hasBottom} onClick={() => controller.regRedo()} title="Redo">
            Redo
          </button>
          <button disabled={!hasBottom} onClick={() => controller.regClear()} title="Clear all registration">
            Clear
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: hasBottom ? 1 : 0.5 }}>
            <input
              type="checkbox"
              disabled={!hasBottom}
              onChange={(e) => controller.setRegScaling(e.target.checked)}
            />
            Scale (atlas)
          </label>
          {!hasBottom && (
            <span style={{ color: 'var(--muted)' }}>— load a 2nd image into the Bottom slot to register</span>
          )}
        </div>
      )}
    </div>
  );
}
