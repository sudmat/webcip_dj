// Curves tab (D5): electrode curves + ARO block plot, sharing one `active` electrode set so the
// curves legend and the ARO toggles/checklist stay in sync (v3 ARO↔curves sync).
import { useMemo, useState } from 'react';
import type { ElectrodeData } from '../api/client';
import { CurvesPanel } from './CurvesPanel';
import { AroPanel } from './AroPanel';

export function CurvesTab({ data }: { data: ElectrodeData }) {
  const allElec = useMemo(() => Object.keys(data.raw).map(Number), [data]);
  const [active, setActive] = useState<Set<number>>(() => new Set(allElec));
  const [threshold, setThreshold] = useState(0.5);

  const toggle = (elec: number) =>
    setActive((s) => {
      const n = new Set(s);
      if (n.has(elec)) n.delete(elec);
      else n.add(elec);
      return n;
    });

  return (
    <div>
      <CurvesPanel data={data} active={active} onToggle={toggle} />
      <AroPanel data={data} active={active} onToggle={toggle} threshold={threshold} setThreshold={setThreshold} />
    </div>
  );
}
