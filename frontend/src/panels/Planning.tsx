import type { ViewerController } from '../render/viewerController';
import { Check, Group, useControllerTick } from './ui';

// Desktop right-dock "Planning" group (desktop/planning_panel.py — CIP's Planning Navigation
// Display). Trajectories and AB measure default on; "Insertion panel" (the plan-data dock)
// defaults off and also drives the clock-dial / carrier-coil guidance.
export function Planning({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const hasPlan = controller.plan !== null;
  const hasLead = controller.electrodes !== null;
  return (
    <Group title="Planning">
      <Check
        label="Trajectories"
        checked={controller.trajectoriesVisible}
        disabled={!hasPlan}
        onChange={(v) => controller.setTrajectoriesVisible(v)}
      />
      <Check
        label="Electrodes"
        checked={controller.leadsVisible}
        disabled={!hasLead}
        onChange={(v) => controller.setLeadsVisible(v)}
      />
      <Check
        label="AB measure"
        checked={controller.abVisible}
        disabled={!hasPlan}
        onChange={(v) => controller.setAbVisible(v)}
      />
      <Check
        label="Insertion panel"
        checked={controller.guidanceOn}
        disabled={!hasPlan}
        onChange={(v) => controller.setGuidanceVisible(v)}
      />
      <Check
        label="Electrode panel"
        checked={controller.electrodePanelOn}
        disabled={!hasLead}
        onChange={(v) => controller.setElectrodePanel(v)}
      />
    </Group>
  );
}
