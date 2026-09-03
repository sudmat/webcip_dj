import { describe, expect, it } from 'vitest';
import {
  APPROACH_ORDER,
  TRAJ_DISPLAY_LEN,
  approachSiblings,
  planStructures,
  planTrajectories,
  structureLabel,
  trajCell,
  trajCenter,
  trajDisplayLine,
  type CipTraj,
  type PlanSession,
  type PlanStructure,
  type PlanTrajectory,
} from '../planObjects';

function cip(over: Partial<CipTraj> = {}): CipTraj {
  return {
    approach: 'RW',
    label: 'RW',
    electrode_id: 19,
    tilt: 58.3251420794511,
    depth: -1.2335446072410312,
    curl_angle: -13.5,
    rw_angle: -144.8,
    curl_clock: '12:30',
    rw_clock: '05:00',
    dist_fn: 0.635405144336059,
    dist_chorda: 0.6408995923431253,
    dist_ossicles: 3.4781000358261798,
    points: [],
    t2w: null,
    desc: [],
    carrier_mesh: null,
    ...over,
  };
}

function traj(id: string, over: Partial<PlanTrajectory> = {}): PlanTrajectory {
  return {
    kind: 'trajectory',
    id,
    name: `R CI532 ${id}`,
    color: [1, 0.35, 0.2],
    visible: true,
    side: 'right',
    entry: [0, 0, 0],
    target: [0, 0, 0],
    device_model: 'CI532',
    extra: { cip: cip() },
    ...over,
  };
}

function struct(name: string, extra: PlanStructure['extra'] = {}): PlanStructure {
  return {
    kind: 'structure',
    id: name,
    name,
    color: [1, 0, 0],
    visible: true,
    opacity: 1,
    source_image: 'img',
    coord_space: 'world',
    mesh: null,
    extra,
  };
}

describe('structureLabel', () => {
  it('leaves a plain structure name alone', () => {
    expect(structureLabel(struct('R. Facial Nerve'))).toBe('R. Facial Nerve');
  });

  // CIP smuggles the scala measurements into the name; the importer split them into extra.ab.
  it('appends the scala-tympani A/B measures', () => {
    const s = struct('R. Scala Tympani', { ab: { a: 7.7, b: 5.6, pa: [], pb: [] } });
    expect(structureLabel(s)).toBe('R. Scala Tympani  (A=7.7,B=5.6)');
  });

  it("formats like Python's %g", () => {
    const s = struct('X', { ab: { a: 8.0, b: 6.25, pa: [], pb: [] } });
    expect(structureLabel(s)).toBe('X  (A=8,B=6.25)');
  });
});

describe('trajDisplayLine', () => {
  // IDL _DrawTraj: from the target, extended THROUGH the entry to a fixed display length.
  it('extends from the target toward the entry to the display length', () => {
    const t = traj('a', { target: [1, 0, 0], entry: [3, 0, 0] });
    const line = trajDisplayLine(t)!;
    expect(line[0]).toEqual([1, 0, 0]);
    expect(line[1]).toEqual([1 + TRAJ_DISPLAY_LEN, 0, 0]);
  });

  it('is null without endpoints', () => {
    expect(trajDisplayLine(traj('a', { entry: null }))).toBeNull();
  });

  it('centres on the midpoint of entry and target', () => {
    expect(trajCenter(traj('a', { target: [0, 2, 4], entry: [2, 0, 0] }))).toEqual([1, 1, 2]);
  });
});

describe('trajCell', () => {
  it('rounds distances to 1 decimal and the tilt to 0', () => {
    const c = cip();
    expect(trajCell(c, 'dist_fn')).toBe('0.6');
    expect(trajCell(c, 'dist_ossicles')).toBe('3.5');
    expect(trajCell(c, 'tilt')).toBe('58');
    expect(trajCell(c, 'depth')).toBe('-1.2');
  });

  it('never shows a negative zero', () => {
    expect(trajCell(cip({ depth: -0.02 }), 'depth')).toBe('0.0');
  });

  it('passes the clock strings through', () => {
    expect(trajCell(cip(), 'curl_clock')).toBe('12:30');
    expect(trajCell(undefined, 'curl_clock')).toBe('');
  });
});

describe('approachSiblings', () => {
  const coch = traj('c', { extra: { cip: cip({ approach: 'Cochleostomy' }) } });
  const rw = traj('r', { extra: { cip: cip({ approach: 'RW' }) } });
  const rwc = traj('w', { extra: { cip: cip({ approach: 'RWcenter' }) } });
  const other = traj('o', { extra: { cip: cip({ approach: 'RW', electrode_id: 12 }) } });

  it('orders the columns Cochleostomy, RWcenter, RW', () => {
    expect(approachSiblings([rw, rwc, coch], rw).map((t) => t.id)).toEqual(['c', 'w', 'r']);
    expect(APPROACH_ORDER.Cochleostomy).toBeLessThan(APPROACH_ORDER.RW);
  });

  it('keeps only the selected electrode model', () => {
    expect(approachSiblings([rw, other], rw).map((t) => t.id)).toEqual(['r']);
  });

  it('is empty with nothing selected', () => {
    expect(approachSiblings([rw], null)).toEqual([]);
  });
});

describe('session accessors', () => {
  const session: PlanSession = {
    objects: [struct('R. Cochlea'), traj('a'), struct('R. Modiolus')],
    state: { module: 'preop', side: 'right' },
  };

  it('splits the objects by kind', () => {
    expect(planStructures(session).map((s) => s.name)).toEqual(['R. Cochlea', 'R. Modiolus']);
    expect(planTrajectories(session).map((t) => t.id)).toEqual(['a']);
  });

  it('handles no plan', () => {
    expect(planStructures(null)).toEqual([]);
    expect(planTrajectories(null)).toEqual([]);
  });
});
