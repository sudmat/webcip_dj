import { useState } from 'react';
import type { ViewerController } from '../render/viewerController';
import {
  ALWAYS,
  COORD_SYSTEMS,
  IMAGE_LOADED,
  fromValues,
  toValues,
  visibleSystems,
  type CoordSystem,
} from '../core/coords';
import type { Vec3 } from '../core/mat4';
import { Check, Group, useControllerTick } from './ui';

// Desktop Coordinates panel: a frame dropdown, three axis rows (label or direction-flip
// select + value box), an "Update coordinates" live-track toggle, and a Go button.
export function Coordinates({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const [systemId, setSystemId] = useState('CT_PATIENT');
  const [choices, setChoices] = useState<[number, number, number]>([0, 0, 0]);
  const [live, setLive] = useState(true);
  const [draft, setDraft] = useState<[string, string, string]>(['', '', '']);

  const img = controller.image;
  const conditions = [ALWAYS, ...(img ? [IMAGE_LOADED] : [])];
  const systems = visibleSystems(conditions);
  const system: CoordSystem =
    systems.find((s) => s.id === systemId) ?? systems[0] ?? COORD_SYSTEMS[0];

  const crosshair = controller.scene.view.crosshair as Vec3;
  const computed =
    img || system.space === 'world' || system.space === null
      ? toValues(system, img, crosshair, choices)
      : [0, 0, 0];
  const shown = live ? (computed.map(fmt) as [string, string, string]) : draft;

  const onSystem = (id: string) => {
    setSystemId(id);
    setChoices([0, 0, 0]);
    setLive(true);
  };
  const onEdit = (i: number, v: string) => {
    const next = (live ? (computed.map(fmt) as [string, string, string]) : draft).slice() as [
      string,
      string,
      string,
    ];
    next[i] = v;
    setDraft(next);
    setLive(false);
  };
  const go = () => {
    const values = shown.map((s) => Number(s) || 0) as [number, number, number];
    controller.moveCrosshair(fromValues(system, img, values, choices));
    setLive(true);
  };

  return (
    <Group title="Coordinates">
      <select
        value={system.id}
        onChange={(e) => onSystem(e.target.value)}
        style={{ width: '100%', marginBottom: 6 }}
      >
        {systems.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      {system.axes.map((axis, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          {axis.options.length > 1 ? (
            <select
              value={choices[i]}
              onChange={(e) => {
                const c = choices.slice() as [number, number, number];
                c[i] = Number(e.target.value);
                setChoices(c);
                setLive(true);
              }}
              style={{ width: 92, flexShrink: 0 }}
            >
              {axis.options.map((o, k) => (
                <option key={k} value={k}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ width: 92, color: 'var(--muted)', flexShrink: 0 }}>
              {axis.options[0].label}
            </span>
          )}
          <input
            value={shown[i]}
            onChange={(e) => onEdit(i, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            style={{ width: '100%' }}
          />
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <Check label="Update coordinates" checked={live} onChange={setLive} />
        <button onClick={go} style={{ marginLeft: 'auto' }} disabled={!img}>
          Go
        </button>
      </div>
    </Group>
  );
}

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(2));
