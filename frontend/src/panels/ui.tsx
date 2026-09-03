import { useEffect, useState } from 'react';
import type { ViewerController } from '../render/viewerController';

// Force a re-render whenever the controller emits (crosshair moves, image loads, etc.).
export function useControllerTick(controller: ViewerController): void {
  const [, setT] = useState(0);
  useEffect(() => controller.subscribe(() => setT((t) => t + 1)), [controller]);
}

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset
      style={{
        border: '1px solid var(--panel-border)',
        borderRadius: 6,
        margin: '0 0 10px',
        padding: '6px 10px 10px',
        minWidth: 0,
      }}
    >
      <legend style={{ padding: '0 4px', color: 'var(--muted)', fontWeight: 600 }}>{title}</legend>
      {children}
    </fieldset>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 0', minWidth: 0 }}>
      <div style={{ width: '7.1em', color: 'var(--muted)', flexShrink: 0 }}>{label}</div>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value || '—'}
      </div>
    </div>
  );
}

export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
      <span style={{ width: '7.1em', color: 'var(--muted)', flexShrink: 0 }}>{label}</span>
      {children}
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 0',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
