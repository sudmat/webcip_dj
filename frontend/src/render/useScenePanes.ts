import { useEffect, type RefObject } from 'react';
import type { ViewName } from '../core/scene';
import { ReslicePane } from './ReslicePane';
import { View3D } from './View3D';
import type { ViewerController } from './viewerController';

// Shared setup for both workspaces (processing four-up + display layout): create the three
// ReslicePanes + the View3D on the given host divs and register them with the controller.
// Layout differs per workspace; the scene wiring lives here.
export function useScenePanes(
  controller: ViewerController,
  hostRefs: RefObject<HTMLDivElement | null>[],
  host3dRef: RefObject<HTMLDivElement | null>,
  views: ViewName[],
  opts?: { compact?: boolean; displayView?: boolean; sliceByVoxel?: boolean; onMaximize?: (view: ViewName) => void },
): void {
  useEffect(() => {
    const hosts = hostRefs.map((r) => r.current).filter(Boolean) as HTMLDivElement[];
    if (hosts.length !== views.length || !host3dRef.current) return;

    const panes = views.map((v, i) => new ReslicePane(hosts[i], v, controller.scene.view));
    panes.forEach((p, i) => {
      p.compact = !!opts?.compact;
      p.sliceByVoxel = !!opts?.sliceByVoxel;
      p.onCrosshair = () => controller.refresh();
      p.onChanged = () => controller.refresh();
      p.onRecenterAll = () => controller.recenterAll();
      p.onMaximize = opts?.onMaximize ? () => opts.onMaximize!(views[i]) : null;
    });
    const view3d = new View3D(host3dRef.current, controller.scene.view);
    view3d.onPick = (world) => controller.moveCrosshair(world);
    view3d.displayView = !!opts?.displayView; // set before attach (attach may push structures)
    controller.attach(panes, view3d);

    const ro = new ResizeObserver(() => controller.refresh());
    hosts.forEach((h) => ro.observe(h));
    ro.observe(host3dRef.current);
    return () => {
      ro.disconnect(); // stop resize callbacks
      controller.detach(); // clear controller refs before deleting -> no stale calls
      panes.forEach((p) => p.delete());
      view3d.delete();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);
}
