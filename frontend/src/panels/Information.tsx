import { useState } from 'react';
import type { ViewerController } from '../render/viewerController';
import { Field, Group, useControllerTick } from './ui';

// Desktop Information panel: Image tab (name/dims/voxel/orientation) + Patient tab.
export function Information({ controller }: { controller: ViewerController }) {
  useControllerTick(controller);
  const [tab, setTab] = useState<'image' | 'patient'>('image');
  const img = controller.image;

  const tabBtn = (id: 'image' | 'patient', label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        background: tab === id ? 'var(--control-hover)' : 'transparent',
        border: 'none',
        borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
        borderRadius: 0,
        fontWeight: tab === id ? 700 : 400,
        padding: '2px 10px',
      }}
    >
      {label}
    </button>
  );

  return (
    <Group title="Information">
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        {tabBtn('image', 'Image')}
        {tabBtn('patient', 'Patient')}
      </div>
      {tab === 'image' ? (
        <>
          <Field label="Name" value={img?.name ?? ''} />
          <Field label="Dimensions" value={img ? img.size.join(' × ') : ''} />
          <Field
            label="Voxel size"
            value={img ? `${img.spacing.map((s) => round(s)).join(' × ')} mm` : ''}
          />
          <Field label="Orientation" value={img?.orientationLabel ?? ''} />
        </>
      ) : (
        <>
          <Field label="MRN" value={img?.patient.id ?? ''} />
          <Field label="Name" value={formatName(img?.patient.name)} />
          <Field label="DOB" value={formatDob(img?.patient.dob)} />
          <Field label="Gender" value={formatSex(img?.patient.sex)} />
        </>
      )}
    </Group>
  );
}

const round = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, ''));

function formatName(n?: string): string {
  if (!n) return '';
  const [last, first] = n.split('^');
  return first ? `${last}, ${first}` : last;
}

function formatDob(d?: string): string {
  if (!d || d.length < 8) return d ?? '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function formatSex(s?: string): string {
  return { M: 'Male', F: 'Female', O: 'Other' }[s ?? ''] ?? (s ?? '');
}
