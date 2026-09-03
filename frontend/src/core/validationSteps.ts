// The validation panel's sequential gating, as pure data — a transliteration of
// validation_panel._sync_steps. Kept out of the .tsx so it can be unit-tested (vitest runs
// only src/**/*.test.ts, in a node environment with no DOM).

export type StepKey = 'structures' | 'registration' | 'electrodes';

export const VALIDATION_STEPS: readonly { key: StepKey; label: string }[] = [
  { key: 'structures', label: '1. Structure segmentation' },
  { key: 'registration', label: '2. Postop – preop registration' },
  { key: 'electrodes', label: '3. Electrodes' },
];

export type Checked = Record<StepKey, boolean>;

export const NONE_CHECKED: Checked = { structures: false, registration: false, electrodes: false };

export interface StepState {
  key: StepKey;
  label: string;
  /** The label reads as live (the desktop enables it once the previous step is checked). */
  enabled: boolean;
  /** The step the human is being asked to judge right now. */
  active: boolean;
  checked: boolean;
  /** Show the "Checked" button — hidden once checked, and before the step is reachable. */
  showCheck: boolean;
  /** The step's own controls (sliders / flip button) respond. */
  controlsEnabled: boolean;
}

/** Per-step UI state for the current tick of the `checked` map.
 *
 *  `hasPostop` gates step 2's CONTROLS only — with no postop there is nothing to flip, but the
 *  desktop leaves its "Checked" button live so a preop-only plan can still reach Done
 *  (_sync_steps disables info["controls"], not info["btn"]). */
export function stepStates(checked: Checked, hasPostop = true): StepState[] {
  let prevOk = true;
  const out: StepState[] = [];
  for (const { key, label } of VALIDATION_STEPS) {
    const isChecked = checked[key];
    const active = prevOk && !isChecked;
    let controlsEnabled = isChecked || active;
    if (key === 'registration') controlsEnabled = controlsEnabled && hasPostop;
    out.push({
      key,
      label,
      enabled: prevOk,
      active,
      checked: isChecked,
      showCheck: !isChecked && prevOk,
      controlsEnabled,
    });
    prevOk = prevOk && isChecked;
  }
  return out;
}

/** Done unlocks only when all three are checked. */
export function doneEnabled(checked: Checked): boolean {
  return VALIDATION_STEPS.every((s) => checked[s.key]);
}

/** The step whose scene setup runs after `key` is checked, or null when that was the last. */
export function nextStep(key: StepKey): StepKey | null {
  const i = VALIDATION_STEPS.findIndex((s) => s.key === key);
  return VALIDATION_STEPS[i + 1]?.key ?? null;
}
