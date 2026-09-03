import type { ViewerController } from '../render/viewerController';
import { Coordinates } from './Coordinates';
import { Display } from './Display';
import { Information } from './Information';
import { Orientation } from './Orientation';
import { Planning } from './Planning';

// The desktop's right-hand "Controls" dock, top-to-bottom: Coordinates, Information, Orientation,
// Display, Planning. The Structures checklist lives in the LEFT column, where the desktop puts it
// (see panels/WorkflowColumn.tsx). AppShell owns the width, scrolling and header.
export function RightDock({ controller }: { controller: ViewerController }) {
  return (
    <div style={{ padding: 10 }}>
      <Coordinates controller={controller} />
      <Information controller={controller} />
      <Orientation controller={controller} />
      <Display controller={controller} />
      <Planning controller={controller} />
    </div>
  );
}
