import { useCallback, useEffect, useRef, useState } from 'react';

// The workspace layout shell — the web equivalent of the desktop's QMainWindow dock arrangement
// (desktop/main.py: a left "Workflow" dock, a right "Controls" dock, and a closable bottom data
// dock, all user-resizable, around the central viewer).
//
//   ┌──────┬────────────────────┬───────┐
//   │ left ┆      centre        ┆ right │   ┆ = drag handle
//   │      ┆┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┆       │
//   │      ┆      bottom        ┆       │
//   └──────┴────────────────────┴───────┘
//
// The bottom region spans only the CENTRE column, between the two side columns — the desktop makes
// the same choice explicitly with setCorner(BottomLeft/BottomRight, Left/RightDockWidgetArea).
//
// Regions are optional: <AppShell right={…}>{centre}</AppShell> renders just a right column.
//
// vtk.js note: region content is never re-parented, only resized. Moving a <canvas> in the DOM
// loses its WebGL context, so collapsing hides with `display: none` and keeps the node in place.
// Resizes reach the renderers through the ResizeObserver useScenePanes already installs per host.

const HANDLE = 5; // px — drag strip between regions

export interface RegionSpec {
  content: React.ReactNode;
  title?: string;
  /** Requested size in px (width for the side columns, height for the bottom). Applied on mount
   *  (unless a persisted size exists) and again whenever the value CHANGES — so a workspace can
   *  retarget a column, as the Display app widens its sidebar for the chart tabs, while a user's
   *  drag still wins in between. */
  size?: number;
  min?: number;
  max?: number;
  /** Show a close button in the header and call this (the desktop's bottom dock is closable). */
  onClose?: () => void;
}

export interface AppShellProps {
  /** Distinguishes one workspace's persisted sizes from another's. */
  storageKey: string;
  left?: RegionSpec;
  right?: RegionSpec;
  bottom?: RegionSpec;
  /** The centre: toolbars + viewer. */
  children: React.ReactNode;
}

// Left matches the desktop (main.py::resizeDocks([left, right], [240, 204])). Right is 300, not
// 204: Qt treats resizeDocks as a floor and then grows the dock to its widgets' sizeHint, whereas a
// CSS width is final — at 204 the Display panel's selects and the Information values clip.
const DEFAULTS = { left: 240, right: 300, bottom: 220 };
const MIN = 120; // smallest a region may be dragged to
// The centre always keeps at least this much — the ceiling for both a drag and the auto-clamp, so
// the two can't drift apart and a region can never squeeze the viewer to nothing.
const MIN_CENTER_H = 200;
const MIN_CENTER_W = 240;

type Edge = 'left' | 'right' | 'bottom';

export function AppShell({ storageKey, left, right, bottom, children }: AppShellProps) {
  const [sizes, setSizes] = useState<Record<Edge, number>>(() => ({
    left: left?.size ?? DEFAULTS.left,
    right: right?.size ?? DEFAULTS.right,
    bottom: bottom?.size ?? DEFAULTS.bottom,
  }));
  const [collapsed, setCollapsed] = useState<Record<Edge, boolean>>({
    left: false,
    right: false,
    bottom: false,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  // The live sizes, for persisting on pointer-up without making it a setState side effect
  // (which React would run twice under StrictMode).
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  // Restore persisted sizes once per workspace. Sizes only — a collapsed panel that stayed
  // collapsed across reloads reads as the app having lost its panels.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`webcip.layout.${storageKey}`);
      if (raw) setSizes((s) => ({ ...s, ...(JSON.parse(raw) as Partial<Record<Edge, number>>) }));
    } catch {
      /* corrupt or unavailable storage — fall back to the defaults */
    }
  }, [storageKey]);

  // A changed `size` request retargets that region (see RegionSpec.size). The refs make this fire
  // on CHANGES only, so it never fights a drag or the restore above.
  const requested = useRef({ left: left?.size, right: right?.size, bottom: bottom?.size });
  useEffect(() => {
    const next: Partial<Record<Edge, number>> = {};
    for (const [edge, size] of [
      ['left', left?.size],
      ['right', right?.size],
      ['bottom', bottom?.size],
    ] as [Edge, number | undefined][]) {
      if (size !== undefined && size !== requested.current[edge]) next[edge] = size;
      requested.current[edge] = size;
    }
    if (Object.keys(next).length) setSizes((s) => ({ ...s, ...next }));
  }, [left?.size, right?.size, bottom?.size]);

  // Region sizes are pixel sizes and do NOT scale with the window — the centre absorbs the change,
  // as the desktop's docks do. The only reaction needed is to shrink a region that no longer fits.
  // Shrink-only and returning the SAME object when nothing changed keeps this idempotent: it cannot
  // feed back into the pane ResizeObservers and oscillate.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return;
      const maxSide = Math.max(MIN, box.width - MIN_CENTER_W);
      const maxBottom = Math.max(MIN, box.height - MIN_CENTER_H);
      setSizes((s) => {
        const next = {
          left: Math.min(s.left, maxSide),
          right: Math.min(s.right, maxSide),
          bottom: Math.min(s.bottom, maxBottom),
        };
        return next.left === s.left && next.right === s.right && next.bottom === s.bottom ? s : next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const persist = useCallback(
    (next: Record<Edge, number>) => {
      try {
        localStorage.setItem(`webcip.layout.${storageKey}`, JSON.stringify(next));
      } catch {
        /* private mode / quota — sizes just don't persist */
      }
    },
    [storageKey],
  );

  // Drag a handle. The size is measured against the shell's own box, so it IS the region's size and
  // the pointer stays glued to the handle wherever the shell sits.
  //
  // The handle element is captured in a local — reading `e.currentTarget` from the async
  // pointermove/up handlers gives null (React clears it after the event), which threw and left
  // pointermove bound: the next drag on ANY handle then also resized this one.
  const startDrag = (edge: Edge) => (e: React.PointerEvent) => {
    e.preventDefault();
    const handleEl = e.currentTarget as HTMLElement;
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    handleEl.setPointerCapture(e.pointerId);
    const spec = edge === 'left' ? left : edge === 'right' ? right : bottom;
    const min = spec?.min ?? MIN;

    const onMove = (ev: PointerEvent) => {
      let v: number;
      if (edge === 'left') v = ev.clientX - box.left;
      else if (edge === 'right') v = box.right - ev.clientX;
      else v = box.bottom - ev.clientY;
      const max = spec?.max ?? (edge === 'bottom' ? box.height - MIN_CENTER_H : box.width - MIN_CENTER_W);
      v = Math.max(min, Math.min(max, Math.round(v)));
      setSizes((s) => (s[edge] === v ? s : { ...s, [edge]: v }));
    };
    const onUp = (ev: PointerEvent) => {
      handleEl.releasePointerCapture?.(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      persist(sizesRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const toggle = (edge: Edge) => setCollapsed((c) => ({ ...c, [edge]: !c[edge] }));

  const handle = (edge: Edge) => (
    <div
      onPointerDown={startDrag(edge)}
      onDoubleClick={() => toggle(edge)} // double-click a handle to collapse / restore
      title="Drag to resize · double-click to collapse"
      style={{
        flexShrink: 0,
        [edge === 'bottom' ? 'height' : 'width']: HANDLE,
        cursor: edge === 'bottom' ? 'row-resize' : 'col-resize',
        background: 'var(--panel-border)',
        touchAction: 'none',
      }}
    />
  );

  // A collapsed region keeps its content mounted (display:none) and shows a thin re-open strip.
  const strip = (edge: Edge, label: string) => (
    <button
      onClick={() => toggle(edge)}
      title={`Show ${label}`}
      style={{
        flexShrink: 0,
        border: 'none',
        borderRadius: 0,
        background: 'var(--panel)',
        color: 'var(--muted)',
        padding: 0,
        [edge === 'bottom' ? 'height' : 'width']: 16,
        writingMode: edge === 'bottom' ? undefined : 'vertical-rl',
      }}
    >
      {edge === 'bottom' ? '▲' : edge === 'left' ? '›' : '‹'}
    </button>
  );

  const region = (edge: Edge, spec: RegionSpec) => {
    const isSide = edge !== 'bottom';
    return (
      <div
        style={{
          display: collapsed[edge] ? 'none' : 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          minWidth: 0,
          minHeight: 0,
          [isSide ? 'width' : 'height']: sizes[edge],
          background: 'var(--panel)',
        }}
      >
        {spec.title && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 6px 3px 8px',
              borderBottom: '1px solid var(--panel-border)',
              color: 'var(--muted)',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {spec.title}
            </span>
            <HeaderBtn label="Collapse" onClick={() => toggle(edge)}>
              {edge === 'bottom' ? '▼' : edge === 'left' ? '‹' : '›'}
            </HeaderBtn>
            {spec.onClose && (
              <HeaderBtn label="Close" onClick={spec.onClose}>
                ✕
              </HeaderBtn>
            )}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto' }}>{spec.content}</div>
      </div>
    );
  };

  return (
    <div ref={rootRef} style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {left && region('left', left)}
      {left && (collapsed.left ? strip('left', left.title ?? 'panel') : handle('left'))}

      {/* Centre column: the viewer, with the bottom dock under it (between the side columns).
          minHeight/minWidth 0 on every level: a flex item defaults to min-*: auto, which lets
          content push it past the container instead of shrinking to fit. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden', // the viewer never scrolls; keeps a mis-sized GL canvas from inflating the page
        }}
      >
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
        {bottom && (collapsed.bottom ? strip('bottom', bottom.title ?? 'panel') : handle('bottom'))}
        {bottom && region('bottom', bottom)}
      </div>

      {right && (collapsed.right ? strip('right', right.title ?? 'panel') : handle('right'))}
      {right && region('right', right)}
    </div>
  );
}

function HeaderBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        border: 'none',
        background: 'transparent',
        color: 'var(--muted)',
        padding: '0 3px',
        lineHeight: 1,
        fontSize: 'var(--fs-xs)',
      }}
    >
      {children}
    </button>
  );
}
