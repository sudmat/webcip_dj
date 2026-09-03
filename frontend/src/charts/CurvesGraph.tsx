// The Curves tab's interactive electrode graph — a port of
// desktop/electrode_panel.py::_GraphCanvas (itself IDL's On_CWCI_Update_Graph).
//
// Top-to-bottom: the distance-to-modiolar-axis CURVES (x = distance-sample INDEX, cropped to the
// used angle range) with place-FREQUENCY ticks along the top and cochlear-ANGLE ticks along the
// bottom; the electrodes ticked at their angle's sample index, with slanted CONNECTORS down to the
// electrode ARRAY (scala-coloured, angle below each). The red cursor is driven by the scrub slider.
//
// Two axes in different units over one x, an electrode strip below the plot, and connectors between
// them: none of that is expressible in recharts, so this is a 2D canvas — the same approach
// ReslicePane uses for its HUD. The simpler analysis tabs do reuse the recharts components.

import { useEffect, useRef } from 'react';
import type { GraphSeries } from '../api/client';

const BG = '#3f4a55';
const FG = '#e8ecf0';
const MUTED = '#9aa6b2';
const GRID = '#6b7885';
const CURSOR = '#ff4040';
const CONN = '#7c8894';
const FRAME = '#5a6672';
const TICK = '#c9d2db';
const ENVELOPE = '#dfe6ec';
const BID_BLUE = '#4a90ff';

const DMAX = 3.0; // distance axis top (mm), as IDL
const ANGLES = [50, 100, 200, 300, 400]; // cochlear-angle ticks (bottom)
const FREQS = [100, 500, 1000, 5000, 10000]; // place-frequency ticks (top)
const HBOX = 0.36; // electrode box half-width in cell units
const DRAW_PLACEHOLDERS = false; // draw IDL's label -1 slots?

// OC / ST / SV / BM
const SCALA_HEX: Record<number, string> = { 0: '#e8241c', 1: '#1a7a2e', 2: '#d99e28', 3: '#5cc24a' };
const SCALA_ABBR: Record<number, string> = { 0: 'OC', 1: 'ST', 2: 'SV', 3: 'BM' };

/** A distinct colour per electrode index (an HSV sweep, as the desktop's _el_color). */
function elColor(i: number, n: number): string {
  return `hsl(${(i / Math.max(n, 1)) * 0.82 * 360}deg 72% ${lightnessFor()}%)`;
}
// Qt's HSV value 0.98 / saturation 0.72 maps to roughly this CSS lightness.
const lightnessFor = () => 63;

const near = (arr: number[], v: number): number => {
  if (!arr.length) return 0;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
};

export interface CurvesGraphProps {
  series: GraphSeries | null;
  /** Scrub angle for the red cursor (null = no cursor). */
  cursorAngle: number | null;
  /** Electrode label highlighted from elsewhere (the table), or null. */
  selectedLabel: number | null;
  onSelect: (label: number | null) => void;
}

export function CurvesGraph({ series, cursorAngle, selectedLabel, onSelect }: CurvesGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<number | null>(null); // contact index under the mouse
  const boxesRef = useRef<{ x0: number; x1: number; y0: number; y1: number; i: number }[]>([]);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w < 2 || h < 2) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const g = canvas.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(g, w, h, series, cursorAngle, selectedLabel, hoverRef.current, boxesRef);
    };
    drawRef.current = draw;
    draw();

    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [series, cursorAngle, selectedLabel]);

  const hit = (e: React.MouseEvent): number | null => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const b of boxesRef.current) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b.i;
    return null;
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 180 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: hoverRef.current != null ? 'pointer' : 'default' }}
        onMouseMove={(e) => {
          const i = hit(e);
          if (i !== hoverRef.current) {
            hoverRef.current = i;
            drawRef.current();
          }
        }}
        onMouseLeave={() => {
          if (hoverRef.current !== null) {
            hoverRef.current = null;
            drawRef.current();
          }
        }}
        onClick={(e) => {
          // Single click selects / deselects, syncing with the electrode table (the desktop's
          // electrode-selection bus). Double-click on/off and the right-click edit menu are
          // clinician EDITS — locked in a read-only .cdb view, so they are not wired.
          const i = hit(e);
          if (i === null || !series) return onSelect(null);
          const label = series.label[i];
          onSelect(selectedLabel === label ? null : label);
        }}
      />
    </div>
  );
}

// --- painting ---------------------------------------------------------------------------

function paint(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  s: GraphSeries | null,
  cursorAngle: number | null,
  selectedLabel: number | null,
  hover: number | null,
  boxesRef: React.MutableRefObject<{ x0: number; x1: number; y0: number; y1: number; i: number }[]>,
) {
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  boxesRef.current = [];
  if (!s || !s.angle.length) {
    g.fillStyle = MUTED;
    g.font = '12px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('No electrodes.', W / 2, H / 2);
    return;
  }

  const [ml, mr, mt, mb] = [46, 28, 6, 4];
  const x0 = ml;
  const x1 = W - mr;
  const angleH = 14;
  const boxH = 26;
  const connH = 26;
  const boxBottom = H - mb - angleH - 2;
  const boxTop = boxBottom - boxH;
  const curve = { left: x0, top: mt, right: x1, bottom: boxTop - connH };

  const n = s.angle.length;
  const dv = s.dist_values;
  const dca = s.dist_cangles;
  const dfreq = s.dist_freq;
  const active = dv.length ? s.onoff.map((v, i) => v > 0 && s.valid[i]) : new Array(n).fill(false);

  // Crop the axis by the VALID electrodes (not the active ones), so switching activation settings
  // only turns curves on/off — it doesn't shift the axis under you.
  const [jlo, jhi] = occupied(dv, dv.length ? s.valid : active);
  const cx = (j: number) => (jhi > jlo ? x0 + ((j - jlo) / (jhi - jlo)) * (x1 - x0) : 0.5 * (x0 + x1));

  const emphIdx =
    hover != null ? hover : selectedLabel != null ? s.label.findIndex((l) => l === selectedLabel) : -1;
  const emph = emphIdx >= 0 ? emphIdx : null;

  const drawIdx = DRAW_PLACEHOLDERS ? [...Array(n).keys()] : [...Array(n).keys()].filter((i) => s.valid[i]);
  const layout = arrayLayout(s, drawIdx, x0, x1);

  if (curve.bottom - curve.top > 24) {
    paintCurves(g, s, curve, cx, active, emph, n);
    if (dca.length) {
      paintAxisLabels(g, curve, cx, jlo, jhi, dca, dfreq);
      paintTicks(g, s, curve, cx, boxTop, layout, dca);
    }
  }
  paintArray(g, s, { left: x0, top: boxTop, right: x1, bottom: boxBottom }, layout, emph, boxesRef, W);
  paintLegend(g, boxTop - connH);
  if (cursorAngle != null && dca.length) paintCursor(g, s, curve, cx, dca, cursorAngle);
}

/** The sample-index range where ANY listed electrode has a valid (0..DMAX) distance, padded. */
function occupied(dv: (number | null)[][], use: boolean[]): [number, number] {
  const cols = dv[0]?.length ?? 0;
  const full: [number, number] = [0, Math.max(cols - 1, 1)];
  if (!dv.length || cols < 2 || !use.some(Boolean)) return full;
  let lo = -1;
  let hi = -1;
  for (let j = 0; j < cols; j++) {
    let any = false;
    for (let i = 0; i < dv.length && !any; i++) {
      if (!use[i]) continue;
      const d = dv[i][j];
      if (d != null && d >= 0 && d <= DMAX) any = true;
    }
    if (any) {
      if (lo < 0) lo = j;
      hi = j;
    }
  }
  if (lo < 0) return full;
  const pad = Math.max(1, Math.round((hi - lo) * 0.03));
  return [Math.max(0, lo - pad), Math.min(cols - 1, hi + pad)];
}

type Rect = { left: number; top: number; right: number; bottom: number };
type Layout = { draw: number[]; centers: number[]; cellw: number; markerX: number | null; kBasal: number };

function paintCurves(
  g: CanvasRenderingContext2D,
  s: GraphSeries,
  r: Rect,
  cx: (j: number) => number,
  active: boolean[],
  emph: number | null,
  n: number,
) {
  const h = r.bottom - r.top;
  const yd = (d: number) => r.bottom - (d / DMAX) * h * 0.9;

  g.strokeStyle = FRAME;
  g.lineWidth = 1;
  g.strokeRect(r.left, r.top, r.right - r.left, h);

  g.font = '9px sans-serif';
  g.textBaseline = 'middle';
  for (let d = 0; d <= DMAX + 1e-6; d += 0.5) {
    const y = yd(d);
    g.strokeStyle = GRID;
    g.setLineDash([1, 3]);
    g.beginPath();
    g.moveTo(r.left, y);
    g.lineTo(r.right, y);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = MUTED;
    g.textAlign = 'right';
    g.fillText(String(d), r.left - 4, y);
  }
  g.textAlign = 'left';
  g.fillStyle = MUTED;
  g.fillText('mm', r.left - 44, r.top + 4);

  const dv = s.dist_values;
  if (!dv.length || !s.dist_cangles.length || dv.length !== n) {
    g.fillStyle = MUTED;
    g.textAlign = 'center';
    g.fillText('no distance curves in this plan', (r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return;
  }

  g.save();
  g.beginPath();
  g.rect(r.left, r.top, r.right - r.left, h);
  g.clip();
  for (let i = 0; i < n; i++) if (active[i] && i !== emph) curve(g, dv[i], cx, yd, elColor(i, n), 1);
  // the white envelope: the minimum distance across active electrodes
  if (active.some(Boolean)) {
    const cols = dv[0].length;
    const env: (number | null)[] = new Array(cols).fill(null);
    for (let j = 0; j < cols; j++) {
      let m = Infinity;
      for (let i = 0; i < n; i++) {
        const d = active[i] ? dv[i][j] : null;
        if (d != null && d >= 0 && d < m) m = d;
      }
      env[j] = Number.isFinite(m) ? m : -1;
    }
    curve(g, env, cx, yd, ENVELOPE, 2);
  }
  if (emph != null && emph >= 0 && emph < n) curve(g, dv[emph], cx, yd, elColor(emph, n), 3);
  g.restore();

  // electrode number at each curve's left tip, in the curve's colour
  g.font = '9px sans-serif';
  g.textAlign = 'right';
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    const tip = curveTip(dv[i], cx, yd, r);
    if (!tip) continue;
    g.fillStyle = elColor(i, n);
    g.fillText(String(s.label[i]), tip[0] - 2, tip[1]);
  }
}

function curve(
  g: CanvasRenderingContext2D,
  val: (number | null)[],
  cx: (j: number) => number,
  yd: (d: number) => number,
  color: string,
  width: number,
) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  let open = false;
  for (let j = 0; j < val.length; j++) {
    const d = val[j];
    if (d == null || !Number.isFinite(d) || d < 0 || d > DMAX) {
      open = false;
      continue;
    }
    const x = cx(j);
    const y = yd(d);
    if (open) g.lineTo(x, y);
    else {
      g.moveTo(x, y);
      open = true;
    }
  }
  g.stroke();
}

/** The leftmost visible point of a distance curve, or null if it never enters the band. */
function curveTip(
  val: (number | null)[],
  cx: (j: number) => number,
  yd: (d: number) => number,
  r: Rect,
): [number, number] | null {
  for (let j = 0; j < val.length; j++) {
    const d = val[j];
    if (d == null || !Number.isFinite(d) || d < 0 || d > DMAX) continue;
    const x = cx(j);
    if (x >= r.left - 0.5) return [x, yd(d)];
  }
  return null;
}

const fmtFreq = (f: number) => (f >= 1000 ? `${Math.floor(f / 1000)}k` : String(f));

function paintAxisLabels(
  g: CanvasRenderingContext2D,
  r: Rect,
  cx: (j: number) => number,
  jlo: number,
  jhi: number,
  dca: number[],
  dfreq: number[],
) {
  g.font = '9px sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  if (dfreq.length) {
    for (const f of FREQS) {
      const j = near(dfreq, f);
      if (j < jlo || j > jhi) continue;
      const x = cx(j);
      g.strokeStyle = GRID;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, r.top);
      g.lineTo(x, r.top + 4);
      g.stroke();
      g.fillStyle = MUTED;
      g.fillText(fmtFreq(f), x, r.top + 9);
    }
  }
  for (const a of ANGLES) {
    const j = near(dca, a);
    if (j < jlo || j > jhi) continue;
    const x = cx(j);
    g.strokeStyle = GRID;
    g.setLineDash([1, 3]);
    g.beginPath();
    g.moveTo(x, r.top + 15);
    g.lineTo(x, r.bottom - 13);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = MUTED;
    g.fillText(String(a), x, r.bottom - 6);
  }
}

/** Electrode x-centres for the array + the tick connectors (they must agree). With an
 *  insertion-depth marker, shrink-to-fit so the whole array + marker sit inside the borders. */
function arrayLayout(s: GraphSeries, draw: number[], x0: number, x1: number): Layout {
  const n = draw.length;
  if (!n) return { draw, centers: [], cellw: 0, markerX: null, kBasal: 0 };
  const bc = s.bid_cells;
  const bi = s.basal_index;
  const kBasal = bi != null && draw.includes(bi) ? draw.indexOf(bi) : n - 1;
  if (bc == null) {
    const cellw = (x1 - x0) / n;
    return { draw, centers: draw.map((_, k) => x0 + (k + 0.5) * cellw), cellw, markerX: null, kBasal };
  }
  const left = -HBOX;
  const right = kBasal + Math.max(bc, HBOX);
  const scale = (x1 - x0) / (right - left);
  return {
    draw,
    centers: draw.map((_, k) => x0 + (k - left) * scale),
    cellw: scale,
    markerX: x0 + (kBasal + bc - left) * scale,
    kBasal,
  };
}

function paintTicks(
  g: CanvasRenderingContext2D,
  s: GraphSeries,
  curveR: Rect,
  cx: (j: number) => number,
  boxTop: number,
  layout: Layout,
  dca: number[],
) {
  layout.draw.forEach((i, k) => {
    if (!s.valid[i]) return;
    const tx = cx(near(dca, s.angle[i]));
    const ax = layout.centers[k];
    g.strokeStyle = TICK;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(tx, curveR.bottom - 3);
    g.lineTo(tx, curveR.bottom + 3);
    g.stroke();
    g.strokeStyle = CONN;
    g.beginPath();
    g.moveTo(tx, curveR.bottom + 3);
    g.lineTo(ax, boxTop);
    g.stroke();
  });
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function paintArray(
  g: CanvasRenderingContext2D,
  s: GraphSeries,
  r: Rect,
  layout: Layout,
  emph: number | null,
  boxesRef: React.MutableRefObject<{ x0: number; x1: number; y0: number; y1: number; i: number }[]>,
  W: number,
) {
  const { draw, centers, cellw } = layout;
  const boxw = Math.min(cellw * 0.72, 26);
  const h = r.bottom - r.top;
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  draw.forEach((i, k) => {
    const cx = centers[k];
    const bx = cx - boxw / 2;
    // the hit-target spans the whole cell (easier to click than the small box)
    boxesRef.current.push({ x0: cx - cellw / 2, x1: cx + cellw / 2, y0: r.top, y1: r.bottom, i });

    if (!s.valid[i]) {
      g.strokeStyle = SCALA_HEX[s.scala[i]] ?? FRAME;
      g.lineWidth = 1;
      roundRect(g, bx, r.top, boxw, h, 3);
      g.stroke();
      return;
    }
    const base = SCALA_HEX[s.scala[i]] ?? '#666666';
    const st = s.onoff[i];
    roundRect(g, bx, r.top, boxw, h, 3);
    if (st > 0) {
      g.fillStyle = base;
      g.fill();
      g.strokeStyle = '#20262c';
      g.lineWidth = 1;
      g.stroke();
    } else if (st === 0) {
      g.strokeStyle = base;
      g.lineWidth = 1.5;
      g.stroke();
    } else {
      g.strokeStyle = MUTED;
      g.lineWidth = 1;
      g.stroke();
    }
    if (i === emph) {
      g.strokeStyle = FG;
      g.lineWidth = 2;
      roundRect(g, bx - 2, r.top - 2, boxw + 4, h + 4, 4);
      g.stroke();
    }
    if (st < 0) {
      // disabled: red cross, and NO number
      g.strokeStyle = CURSOR;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(bx, r.top);
      g.lineTo(bx + boxw, r.bottom);
      g.moveTo(bx + boxw, r.top);
      g.lineTo(bx, r.bottom);
      g.stroke();
    } else {
      g.fillStyle = FG;
      g.fillText(String(s.label[i]), cx, (r.top + r.bottom) / 2);
    }
    if (s.scala_edited[i] || s.deact_edited[i]) {
      g.fillStyle = CURSOR; // clinician-touched block
      g.textAlign = 'left';
      g.fillText('*', bx + boxw - 2, r.top - 1);
      g.textAlign = 'center';
    }
    const atext = `${Math.round(s.angle[i])}°`; // angle BELOW the box
    g.font = '10px sans-serif';
    g.fillStyle = MUTED;
    g.fillText(atext, cx, r.bottom + 7);
    if (s.angle_edited[i]) {
      g.fillStyle = CURSOR;
      g.fillText('*', cx + g.measureText(atext).width / 2 + 3, r.bottom + 7);
    }
    g.font = '11px sans-serif';
  });

  // the array's direction: a line from the basal electrode's right edge out to the right border
  if (centers.length) {
    const ymid = (r.top + r.bottom) / 2;
    g.strokeStyle = CONN;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(centers[layout.kBasal] + boxw / 2, ymid);
    g.lineTo(W, ymid);
    g.stroke();
  }

  // the blue basal-insertion-depth I-beam, with the depth (mm) labelled above it
  if (layout.markerX != null && s.bid != null) {
    const mx = layout.markerX;
    g.strokeStyle = BID_BLUE;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(mx, r.top);
    g.lineTo(mx, r.bottom);
    for (const y of [r.top, r.bottom]) {
      g.moveTo(mx - 3, y);
      g.lineTo(mx + 3, y);
    }
    g.stroke();
    g.font = '9px sans-serif';
    g.fillStyle = BID_BLUE;
    g.fillText(s.bid.toFixed(2), Math.min(mx, r.right - 22), r.top - 7);
  }
}

function paintLegend(g: CanvasRenderingContext2D, y0: number) {
  g.font = '9px sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  let y = y0 + 2;
  for (const code of [1, 2, 3, 0]) {
    g.fillStyle = SCALA_HEX[code];
    g.fillRect(2, y, 8, 8);
    g.fillStyle = MUTED;
    g.fillText(SCALA_ABBR[code], 12, y + 4);
    y += 13;
  }
}

function paintCursor(
  g: CanvasRenderingContext2D,
  s: GraphSeries,
  r: Rect,
  cx: (j: number) => number,
  dca: number[],
  a: number,
) {
  const x = cx(near(dca, a));
  g.strokeStyle = CURSOR;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, r.top);
  g.lineTo(x, r.bottom);
  g.stroke();

  // the angle / freq / d / z readout beside the line (freq from the place-freq map, d + z from
  // the centerline via cie_compute_cview)
  const jd = dca.length ? near(dca, a) : 0;
  const freq = s.dist_freq.length ? s.dist_freq[jd] : NaN;
  let d = NaN;
  let z = NaN;
  if (s.cl_cangles.length && s.cl_dist.length) {
    const jc = near(s.cl_cangles, a);
    d = s.cl_dist[jc];
    z = s.cl_z[jc];
  }
  const lines = [
    `∠ ${Math.round(a)}°`,
    Number.isFinite(freq) ? `f ${Math.round(freq)} Hz` : '',
    Number.isFinite(d) ? `d ${d.toFixed(2)} mm` : '',
    Number.isFinite(z) ? `z ${z.toFixed(2)} mm` : '',
  ].filter(Boolean);

  g.font = '9px sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const tw = Math.max(...lines.map((t) => g.measureText(t).width)) + 8;
  const left = x < (r.left + r.right) / 2 ? x + 4 : x - 4 - tw;
  const top = r.top + 3;
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 1;
  roundRect(g, left, top, tw, 12 * lines.length + 4, 3);
  g.fill();
  g.stroke();
  g.fillStyle = '#ffffff';
  lines.forEach((t, k) => g.fillText(t, left + 4, top + 8 + k * 12));
}
