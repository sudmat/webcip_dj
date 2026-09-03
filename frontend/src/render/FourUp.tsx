import { useRef, useState } from 'react';
import type { ViewName } from '../core/scene';
import { useScenePanes } from './useScenePanes';
import type { ViewerController } from './viewerController';

// Processing four-up grid: Coronal (TL), Sagittal (TR), Axial (BL), 3D (BR). A pane can
// maximize to fill the grid. Scene wiring is shared via useScenePanes.
const VIEWS: ViewName[] = ['coronal', 'sagittal', 'axial'];

export function FourUp({ controller }: { controller: ViewerController }) {
  const hostRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const host3dRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState<ViewName | null>(null);

  useScenePanes(controller, hostRefs, host3dRef, VIEWS, {
    onMaximize: (v) => setMaximized((m) => (m === v ? null : v)),
  });

  const cellStyle = (view: ViewName | '3d'): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'relative',
      border: '1px solid #000',
      background: '#000',
      minHeight: 0,
      minWidth: 0,
    };
    if (maximized) {
      if (view === maximized) return { ...base, gridColumn: '1 / 3', gridRow: '1 / 3' };
      return { ...base, display: 'none' };
    }
    return base;
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 2,
        width: '100%',
        height: '100%',
        background: '#000',
      }}
    >
      {VIEWS.map((v, i) => (
        <div key={v} style={cellStyle(v)}>
          <div ref={hostRefs[i]} style={{ width: '100%', height: '100%' }} />
        </div>
      ))}
      <div style={cellStyle('3d')}>
        <div ref={host3dRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
