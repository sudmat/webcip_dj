import type { ViewerController } from '../render/viewerController';
import { planStructures, structureLabel } from '../core/planObjects';
import { Group, useControllerTick } from './ui';

// Port of desktop/structures_panel.py: one row per segmented structure — a checkbox that
// shows/hides the mesh (3D and its 2D cross-section), a colour swatch and the name — plus a
// tristate "All". Clicking a row focuses that structure everywhere (crosshair to its centroid).
// Fed live from the loaded plan's session, so it rebuilds whenever the plan changes.
export function Structures({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const structs = controller.planStructures();
  const labels = new Map(planStructures(controller.plan).map((o) => [o.id, structureLabel(o)]));
  const visible = structs.filter((s) => s.visible).length;
  const allState = structs.length === 0 ? 'none' : visible === structs.length ? 'all' : visible === 0 ? 'none' : 'some';
  // A checkbox's "partial" state is DOM-only, so it is set through a callback ref.
  const allRef = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = allState === 'some';
  };

  // Show all unless they are already all shown, then hide all (_on_all_clicked).
  const onAll = () => {
    const show = allState !== 'all';
    structs.forEach((s) => controller.updateStructure(s.id, { visible: show }));
  };

  return (
    <Group title="Structures">
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 }}>
        <input
          ref={allRef}
          type="checkbox"
          aria-label="Show or hide all structures"
          checked={allState === 'all'}
          disabled={!structs.length}
          onChange={onAll}
          title="Show / hide all structures"
        />
        <span style={{ color: 'var(--muted)' }}>All</span>
      </label>
      {structs.length === 0 ? (
        <div style={{ color: 'var(--muted)', padding: '2px 0' }}>(no structures)</div>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {structs.map((s) => (
            <div
              key={s.id}
              onClick={() => controller.focusStructure(s.id)}
              title="Click to centre the views on this structure"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={s.visible}
                onClick={(e) => e.stopPropagation()} // toggling should not also re-focus
                onChange={(e) => controller.updateStructure(s.id, { visible: e.target.checked })}
              />
              <span
                style={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  border: '1px solid #787878',
                  background: `rgb(${s.color.map((c) => Math.round(c * 255)).join(',')})`,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {labels.get(s.id) ?? s.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </Group>
  );
}
