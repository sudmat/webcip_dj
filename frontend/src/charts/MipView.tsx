// The MIP-projection tab's image view — a port of desktop/electrode_panel.py::_ZoomView.
// The projection itself is rendered server-side by projects.cip.projection.render_for_lead and
// arrives as a PNG; this adds the desktop's interactions: wheel zoom about the cursor, drag to
// pan, double-click to fit, and click an electrode to select it (with a ring on the selection).

import { useEffect, useRef, useState } from 'react';
import type { MipPoints } from '../api/client';

const RING = '#ffdd33';
const HIT_PX = 14; // how close a click must land to count as picking that electrode

export function MipView({
  src,
  points,
  selectedLabel,
  onSelect,
}: {
  src: string;
  points: MipPoints | null;
  selectedLabel: number | null;
  onSelect: (label: number | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [view, setView] = useState<{ scale: number; tx: number; ty: number } | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Fit the image in the pane (the desktop's _fit_scale / _reset_view).
  const fit = () => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img || !img.naturalWidth) return;
    const s = Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight);
    setView({
      scale: s,
      tx: (wrap.clientWidth - img.naturalWidth * s) / 2,
      ty: (wrap.clientHeight - img.naturalHeight * s) / 2,
    });
  };

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      fit();
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => (view ? draw() : fit()));
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const draw = () => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!wrap || !canvas || !img || !view) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = view.scale < 3; // nearest-neighbour once zoomed well past 1:1
    g.drawImage(img, view.tx, view.ty, img.naturalWidth * view.scale, img.naturalHeight * view.scale);

    if (selectedLabel != null && points) {
      g.strokeStyle = RING;
      g.lineWidth = 2;
      for (const p of points.points) {
        if (p.label !== selectedLabel) continue;
        g.beginPath();
        g.arc(view.tx + p.x * view.scale, view.ty + p.y * view.scale, 7, 0, 2 * Math.PI);
        g.stroke();
      }
    }
  };

  useEffect(draw);

  const toImage = (e: React.MouseEvent): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return null;
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left - view.tx) / view.scale, (e.clientY - r.top - view.ty) / view.scale];
  };

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', minHeight: 200, background: '#000', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: drag.current ? 'grabbing' : 'crosshair' }}
        onWheel={(e) => {
          if (!view) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - r.left;
          const my = e.clientY - r.top;
          const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          const s = Math.max(0.05, Math.min(40, view.scale * f));
          // keep the point under the cursor fixed
          setView({ scale: s, tx: mx - ((mx - view.tx) / view.scale) * s, ty: my - ((my - view.ty) / view.scale) * s });
        }}
        onPointerDown={(e) => {
          if (!view) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !view) return;
          setView({ ...view, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) });
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          // a click (not a drag) picks the nearest electrode
          if (!d || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3 || !points) return;
          const p = toImage(e);
          if (!p) return;
          let best: number | null = null;
          let bd = Infinity;
          for (const q of points.points) {
            const dist = Math.hypot(q.x - p[0], q.y - p[1]) * (view?.scale ?? 1);
            if (dist < bd) {
              bd = dist;
              best = q.label;
            }
          }
          onSelect(bd <= HIT_PX ? (best === selectedLabel ? null : best) : null);
        }}
        onDoubleClick={fit}
        title="Wheel: zoom · drag: pan · double-click: fit · click an electrode to select"
      />
    </div>
  );
}
