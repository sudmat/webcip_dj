// PDF tab (D6): a v3-style landscape report — header (title · Plan ID / Side) · electrode table
// (left) + four 3D screenshots (right, 2×2) · three charts in a row · the electrode curves full
// width · medical disclaimer. Captured with html2canvas and saved as one landscape A4 via jsPDF.
import { useCallback, useEffect, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { ElectrodeData } from '../api/client';
import { asset } from '../api/paths';
import type { ViewerController } from '../render/viewerController';
import { ElectrodeTable } from './ElectrodePanel';
import { DistanceAngleChart, FreqMismatchChart, AngleByFreqChart } from './ElectrodeCharts';
import { CurvesPanel } from './CurvesPanel';

// Matches v3's `#pdf-report` (webtool-postop.php): 810px wide, captured and stretched to fill a
// portrait A4 so every panel lands at the same absolute size as v3's report.
const REPORT_W = 810;

export function PdfPanel({
  data,
  controller,
  title,
}: {
  data: ElectrodeData;
  controller: ViewerController;
  title: string;
}) {
  const reportRef = useRef<HTMLDivElement>(null);
  const [shots, setShots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const allActive = new Set(Object.keys(data.raw).map(Number));

  const parts = title.trim().split(/\s+/);
  const side = parts.length > 1 ? parts[parts.length - 1] : '';
  const planId = parts.slice(0, parts.length > 1 ? -1 : undefined).join(' ');

  // Capture the four 3D snapshots as soon as the report is shown (not only on Download), and
  // re-capture when the case/data changes.
  const capture = useCallback(async () => {
    setShots(await controller.capturePdf3D());
  }, [controller]);
  useEffect(() => {
    capture();
  }, [capture, data]);

  async function download() {
    setBusy(true);
    try {
      if (!shots.length) await capture();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
      const el = reportRef.current;
      if (!el) return;
      const canvas = await html2canvas(el, { backgroundColor: '#ffffff', scale: 2, useCORS: true });
      // v3 downloadPDF: portrait A4, stretch the report to fill the page (fixed placement, not
      // aspect-fit) so panels match v3's absolute sizes exactly.
      const pdf = new jsPDF('p', 'mm', 'a4');
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 8, 205, 298, '', 'FAST');
      pdf.save(`${title.replace(/\s+/g, '_') || 'report'}.pdf`);
    } finally {
      setBusy(false);
    }
  }

  const infoTd: React.CSSProperties = { border: '1px solid #ccc', padding: '3px 10px' };

  return (
    <div>
      <button onClick={download} disabled={busy} style={{ marginBottom: 10, padding: '6px 14px', fontSize: 'var(--fs-base)' }}>
        {busy ? 'Generating…' : 'Download PDF Report'}
      </button>
      <div style={{ overflowX: 'auto' }}>
        {/* Mirrors v3's #pdf-report (webtool-postop.php): 810px, 8px 12px padding, Arial. */}
        <div
          ref={reportRef}
          style={{ width: REPORT_W, background: '#fff', color: '#334155', padding: '8px 12px', boxSizing: 'border-box', fontFamily: 'Arial, Helvetica, sans-serif' }}
        >
          {/* header: logo (left) · Plan ID / Side (center) · spacer (right) */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #ccc' }}>
            <div style={{ flex: '0 0 170px' }}>
              <img src={asset('vise_logo.png')} alt="VISE" style={{ height: 60, width: 'auto' }} />
            </div>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <table style={{ border: '1px solid #ccc', margin: '0 auto', fontSize: 12, borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={infoTd}>Plan ID:</td>
                    <td style={infoTd}>{planId}</td>
                  </tr>
                  <tr>
                    <td style={infoTd}>Side:</td>
                    <td style={infoTd}>{side.toUpperCase()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ flex: '0 0 120px' }} />
          </div>

          {/* Row 1: electrode table (left, fills) + 3D 2×2 (right, 375×360) */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ElectrodeTable data={data} compact />
            </div>
            <div style={{ flex: '0 0 375px', height: 360, background: '#000', overflow: 'hidden' }}>
              {/* capturePdf3D order: 0=+scala top, 1=modiolus top, 2=+scala bottom, 3=modiolus
                  bottom. v3's grid puts the bottom views on the first row, so reorder to match.
                  Each quadrant floats and the img uses max-width/height — NOT object-fit, which
                  html2canvas ignores and would squish the snapshot in the PDF. */}
              {(shots.length ? [shots[2], shots[3], shots[0], shots[1]] : ['', '', '', '']).map((src, i) => (
                <div
                  key={i}
                  style={{ width: '50%', height: '50%', float: 'left', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {src ? (
                    <img src={src} alt={`3D ${i + 1}`} style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
                  ) : (
                    <span style={{ color: '#94a3b8', fontSize: 11 }}>Loading 3D…</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Row 2: three charts side by side (height 250) */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DistanceAngleChart data={data} height={250} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <FreqMismatchChart data={data} height={250} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <AngleByFreqChart data={data} height={250} />
            </div>
          </div>

          {/* Row 3: electrode curves full width (height 250) */}
          <div style={{ width: '100%', marginBottom: 10 }}>
            <CurvesPanel data={data} active={allActive} onToggle={() => {}} height={250} />
          </div>

          {/* Disclaimer (v3 text) */}
          <div style={{ padding: '8px 0', fontSize: 10, color: '#475569', borderTop: '1px solid #ccc' }}>
            <p style={{ fontWeight: 'bold', marginBottom: 4 }}>Medical Disclaimer</p>
            This site is not an attempt to practice medicine or provide specific medical advice and should not be used
            to make a diagnosis or to replace or overrule a qualified health care provider's judgment. All content is
            for research purposes only. NEVER RELY ON INFORMATION ON THIS WEB SITE IN PLACE OF PROFESSIONAL MEDICAL
            ADVICE.
            <br />
            <br />
            Vanderbilt University Medical Center and Vanderbilt University will not be liable for any direct, indirect,
            consequential, special, exemplary, or other damages arising therefrom.
          </div>
        </div>
      </div>
    </div>
  );
}
