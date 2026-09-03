import { useEffect, useRef, useState } from 'react';

// The workflow column's step control. The desktop's steps are QPushButtons with a QMenu — one
// button per numbered step, its options behind the menu — so the column stays a readable list of
// numbered stages rather than a wall of buttons.

export interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Rendered with a check, for the desktop's checkable items (the chosen ear, the last-searched
   *  electrode type). */
  checked?: boolean;
  title?: string;
  separatorBefore?: boolean;
  /** A submenu (the desktop's 'Electrode type ▶'). Its own onClick is then ignored. */
  children?: MenuItem[];
}

export function MenuButton({
  label,
  items,
  disabled,
  title,
  status,
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  title?: string;
  /** Per-step state, shown as a leading marker — the same vocabulary as the Auto-process rows. */
  status?: 'idle' | 'running' | 'done' | 'failed';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {status && status !== 'idle' && (
          <span style={{ color: MARK_COLOR[status] }}>{MARK[status]}</span>
        )}
        <span style={{ flex: 1 }}>{label}</span>
        <span style={{ color: 'var(--muted)' }}>▾</span>
      </button>
      {open && (
        <div style={menu}>
          {items.map((it, i) => (
            <div key={i}>
              {it.separatorBefore && <div style={sep} />}
              <Row item={it} onPick={() => setOpen(false)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ item: it, onPick }: { item: MenuItem; onPick: () => void }) {
  const [openSub, setOpenSub] = useState(false);
  if (it.children) {
    return (
      <div>
        <button
          onClick={() => !it.disabled && setOpenSub((o) => !o)}
          disabled={it.disabled}
          title={it.title}
          style={{ ...item, display: 'flex', alignItems: 'center' }}
        >
          <span style={{ width: 14, display: 'inline-block' }} />
          <span style={{ flex: 1 }}>{it.label}</span>
          <span style={{ color: 'var(--muted)' }}>{openSub ? '▾' : '▸'}</span>
        </button>
        {/* Inline rather than a flyout: the column is narrow, and a 20-model list has to
            scroll somewhere. */}
        {openSub && (
          <div style={{ maxHeight: 260, overflowY: 'auto', borderLeft: '2px solid var(--panel-border)', marginLeft: 8 }}>
            {it.children.map((c, j) => (
              <Row key={j} item={c} onPick={onPick} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <button
      onClick={() => {
        if (it.disabled) return;
        onPick();
        it.onClick?.();
      }}
      disabled={it.disabled}
      title={it.title}
      style={item}
    >
      <span style={{ width: 14, display: 'inline-block' }}>{it.checked ? '✓' : ''}</span>
      {it.label}
    </button>
  );
}

const MARK = { running: '⏳', done: '✓', failed: '✗' } as const;
const MARK_COLOR = { running: 'var(--info)', done: 'var(--ok)', failed: 'var(--err)' } as const;

const menu: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  minWidth: '100%',
  width: 'max-content',
  maxWidth: 320,
  maxHeight: '60vh',
  overflowY: 'auto',
  zIndex: 20,
  background: 'var(--panel-alt)',
  border: '1px solid var(--panel-border)',
  borderRadius: 4,
  padding: '3px 0',
  boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
};
const item: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
  padding: '4px 10px',
  whiteSpace: 'nowrap',
};
const sep: React.CSSProperties = {
  borderTop: '1px solid var(--panel-border)',
  margin: '3px 0',
};
