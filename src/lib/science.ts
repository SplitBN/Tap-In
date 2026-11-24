// Every formula here must be listed in docs/SPEC.md → "Science sources".
// Rule: verify the cited source before changing a formula.

import type { LoadType, Mechanic, Unit } from '../db/types';

export const KG_PER_LB = 0.45359237; // exact, by definition (international pound, 1959)
export const toKg = (v: number, unit: Unit) => (unit === 'kg' ? v : v * KG_PER_LB);
export const fromKg = (kg: number, unit: Unit) => (unit === 'kg' ? kg : kg / KG_PER_LB);

/** RIR-based RPE scale (Zourdos et al. 2016, J Strength Cond Res 30(1):267–275, Table 1; Helms et al. 2016, Strength Cond J
 *  38(4):42–49). The scale is NOT a clean "RPE = 10 − RIR" line; that only holds in its top range:
 *    10 = max effort (0 RIR) · 9.5 = no further rep, but could add load · 9 = 1 RIR · 8.5 = 1–2 · 8 = 2 · 7.5 = 2–3 · 7 = 3
 *    5–6 = 4–6 reps left (one band) · 3–4 = light effort · 1–2 = little to no effort (no RIR at all).
 *  Where the naive line breaks: RPE 9.5 is 0 reps in reserve (not 0.5: e.g. a 1RM single that could take 2 kg more but
 *  never a 2nd rep); RPE 5 and 6 are the same 4–6 band (not 5 and 4); RPE ≤ 4 says nothing about reps left (an easy
 *  4-rep warm-up at RPE 3 is not "7 RIR"); RIR 4–6 maps only to the band "RPE 5–6", RIR > 6 to no RPE. So sets store
 *  what the user entered (SetLog.effortInput) and the other scale is derived only where the table gives one value;
 *  otherwise the derived field is null, never an invented number. RIR self-ratings are also less accurate further from
 *  failure (Zourdos et al. 2016), so anything beyond ~3–4 RIR is a rough figure on either scale. */
export function rpeToRir(rpe: number): number | null {
  if (rpe >= 9.5) return 0; // 10 and 9.5: no rep left (9.5: the load could go up a little, the reps could not)
  if (rpe >= 6.5) return 10 - rpe; // 9→1, 8.5→1.5 (scale "1–2"), 8→2, 7.5→2.5, 7→3; 6.5 (not on the scale) → 3.5, between 3 and the 4–6 band
  if (rpe >= 5) return 5; // the 5–6 band = 4–6 reps left → its midpoint (±1 rep by definition)
  return null; // light / little effort: not defined in reps in reserve
}
/** RPE for an RIR, only where the scale gives one value (0–3.5 RIR; 0.5 RIR ≈ 9.5). RIR 4–6 is the band "RPE 5–6",
 *  beyond that the scale has nothing → null. */
export const rirToRpe = (rir: number): number | null => (rir <= 3.5 ? 10 - Math.max(0, rir) : null);
/** Reps in reserve of a set or suggestion: the stored RIR, else derived from an RPE-only record (null = effort unknown). */
export const rirOf = (l: { rir?: number | null; rpe?: number | null } | null | undefined): number | null =>
  l?.rir ?? (l?.rpe != null ? rpeToRir(l.rpe) : null);

/** Total load actually moved, kg. Bodyweight exercises add the bodyweight snapshot. */
export function totalLoadKg(loadType: LoadType, loadKg: number | null | undefined, bodyweightKg: number | null | undefined) {
  const l = loadKg ?? 0;
  if (loadType === 'weighted') return l;
  const bw = bodyweightKg ?? 0;
  return loadType === 'assisted' ? bw - l : bw + l;
}

/** Reps-to-failure above which an e1RM is shown with ≈ and left out of e1RM PRs / analysis. Reynolds, Gordon & Robergs
 *  2006 (JSCR 20(3):584–592) conclude no more than 10 reps for LINEAR equations (Epley, Brzycki) and note non-linear
 *  equations are used up to ~15 reps; Mayhew et al. 2008 (JSCR 22(5):1570–1577) find accuracy better below 10 reps to
 *  fatigue. We use the non-linear Wathen equation, so 11–12 reps to failure still count (a few % more error) and
 *  > 12 is flagged. One constant for the set table, PRs, charts and the agent, so the numbers agree everywhere. */
export const RELIABLE_MAX_RTF = 12;

/** Wathen (1994) ratio 1RM / load at r reps to failure. */
const wathen = (r: number) => 1 / (0.488 + 0.538 * Math.exp(-0.075 * r));

export interface E1rm {
  kg: number; // 0 when it can't be estimated
  /** reps to failure used = reps + RIR */
  rtf: number;
  /** rtf ≤ RELIABLE_MAX_RTF */
  reliable: boolean;
  /** no effort logged: computed from reps alone, so the true value is at least this (see below) */
  lowerBound: boolean;
}
/** Estimated 1RM of one set — the single e1RM function used everywhere (set table, best set, PRs, charts, analysis).
 *  Reps-to-failure = reps + RIR (the RIR approach of Helms et al. 2016 / Zourdos et al. 2016), then Wathen (1994,
 *  NSCA Essentials of Strength Training and Conditioning, pp. 435–439): 1RM = w / (0.488 + 0.538·e^(−0.075·r)).
 *  Why Wathen: LeSuer et al. 1997 (JSCR 11(4):211–213) compared seven equations (Brzycki, Epley, Lander, Lombardi,
 *  Mayhew, O'Conner, Wathen) and only Mayhew and Wathen predicted bench press 1RM without significant error, and only
 *  Wathen the squat (all underestimated the deadlift by ~9–14 %); form verified in Mayhew et al. 2008, Table 2. Within
 *  2–10 reps it is within ~1 % of Epley, and it bends at high reps instead of growing linearly.
 *  r ≤ 1 → the load itself (a 1-rep max is its own 1RM; Wathen would say 1.013·w). Between 1 and 2 reps to failure
 *  (half-RIR entries) we blend linearly to Wathen(2), so the value never jumps.
 *  Effort unknown (rir null): reps alone. Reps actually done can only be ≤ reps to failure, and the equations rise with
 *  reps, so this is a LOWER BOUND, not "assumed failure" — shown as ≥ and still allowed to set a PR (beating a record
 *  with a lower bound means the real value beat it too). Bodyweight lifts: pass the total load (bodyweight + added, or
 *  bodyweight − assistance). */
export function e1rm(weightKg: number, reps: number, rir: number | null | undefined): E1rm {
  const lowerBound = rir == null;
  const rtf = reps + Math.max(0, rir ?? 0);
  if (reps <= 0 || weightKg <= 0) return { kg: 0, rtf, reliable: false, lowerBound };
  const ratio = rtf <= 1 ? 1 : rtf < 2 ? 1 + (wathen(2) - 1) * (rtf - 1) : wathen(rtf);
  return { kg: weightKg * ratio, rtf, reliable: rtf <= RELIABLE_MAX_RTF, lowerBound };
}

/** e1RM of a logged set (or a set being filled in): total load from its load type, RIR from rirOf. null when it can't
 *  be estimated honestly: no reps or load, or a bodyweight/assisted set without a known bodyweight (no guessing). */
export function setE1rm(s: { loadType: LoadType; loadKg?: number | null; bodyweightKg?: number | null; reps?: number | null; rir?: number | null; rpe?: number | null }): E1rm | null {
  if (!s.reps || s.reps <= 0) return null;
  if (s.loadType === 'weighted' ? s.loadKg == null : s.bodyweightKg == null) return null;
  const est = e1rm(totalLoadKg(s.loadType, s.loadKg, s.bodyweightKg), s.reps, rirOf(s));
  return est.kg > 0 ? est : null;
}

/** Weight you could lift for n reps to failure, inverting the same equation (10RM etc.). */
export const nRepMax = (oneRm: number, n: number) => (n <= 1 ? oneRm : n < 2 ? oneRm / (1 + (wathen(2) - 1) * (n - 1)) : oneRm / wathen(n));

/** Drop-set step: ~20–25% load reduction per drop is the typical protocol in the drop-set literature
 *  (Coleman et al. 2023, Sports Med Open, "Effects of Drop Sets on Skeletal Muscle Hypertrophy", PMC10390395;
 *  background: Schoenfeld & Grgic 2018, Strength Cond J 40(6):95–98).
 *  We use 20% and round to the equipment step, never returning the same weight. */
export const DROP_FRACTION = 0.2;
export function suggestDrop(prevKg: number, stepKg: number) {
  const target = prevKg * (1 - DROP_FRACTION);
  let r = roundTo(target, stepKg);
  if (r >= prevKg) r = Math.max(0, prevKg - stepKg);
  return r;
}

/** Default rest by mechanic. Values are the user's choice (compound 3 min, isolation 1.5 min);
 *  longer rest favours strength/hypertrophy on multi-joint lifts (Schoenfeld et al. 2016, JSCR 30(7):1805–1812). */
export const defaultRestSec = (m: Mechanic, compound: number, isolation: number) => (m === 'compound' ? compound : isolation);

export const roundTo = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);

/** Typical smallest jump on the equipment, kg (plate pairs, dumbbell racks, pin stacks). Not science, just gym reality. */
export function defaultStepKg(equipment: string, unit: Unit) {
  if (unit === 'lb') return toKg(equipment === 'machine' || equipment === 'cable' ? 10 : 5, 'lb');
  if (equipment === 'machine') return 5;
  if (equipment === 'dumbbell' || equipment === 'kettlebells') return 2;
  return 2.5;
}

/** Weight-picker steps offered per unit. */
export const WEIGHT_STEPS: Record<Unit, number[]> = { kg: [0.5, 1, 1.25, 2, 2.5, 5], lb: [1, 2.5, 5, 10] };
// Usual counterpart of each step in the other unit (plates: 1.25 kg ≈ 2.5 lb, 2.5 kg ≈ 5 lb, 5 kg ≈ 10 lb).
const STEP_EQUIV: Record<Unit, Record<string, number>> = {
  kg: { '1': 0.5, '2.5': 1.25, '5': 2.5, '10': 5 },
  lb: { '0.5': 1, '1': 2.5, '1.25': 2.5, '2': 5, '2.5': 5, '5': 10 },
};
/** A stored step (kg) as a standard step of `unit`, so plate steps round-trip between units: 5 lb (2.268 kg) shows as
 *  2.5 kg, and 2.5 kg shows as 5 lb. Exact steps of either unit map through STEP_EQUIV; anything else snaps to the nearest. */
export function stepInUnit(stepKg: number, unit: Unit): number {
  const match = (u: Unit) => WEIGHT_STEPS[u].find((s) => Math.abs(toKg(s, u) - stepKg) < 0.005);
  const own = match(unit);
  if (own != null) return own;
  const other: Unit = unit === 'kg' ? 'lb' : 'kg';
  const o = match(other);
  if (o != null && STEP_EQUIV[unit][String(o)] != null) return STEP_EQUIV[unit][String(o)];
  const u = fromKg(stepKg, unit);
  return WEIGHT_STEPS[unit].reduce((p, c) => (Math.abs(c - u) < Math.abs(p - u) ? c : p));
}
/** The step actually used in `unit`, back in kg (for rounding suggestions to loadable weights). */
export const snappedStepKg = (stepKg: number, unit: Unit) => toKg(stepInUnit(stepKg, unit), unit);

// ---------------- progression target ("what to lift today") ----------------
/** Effort we aim working sets at: at least 1 rep in reserve (RIR-based RPE ≤ 9). A convention, not a published threshold. */
export const TARGET_RIR = 1;

export type ProgressionDecision = 'increase' | 'reps' | 'hold' | 'reduce';
export interface ProgressionSet { setNo: number; side: 'both' | 'left' | 'right'; loadKg: number; reps: number; rir: number | null }
export interface ProgressionTarget {
  decision: ProgressionDecision;
  /** change of the logged load (kg) on every row: + step, − step or 0. For assisted lifts "heavier" = less assistance, so increase is negative. */
  loadDeltaKg: number;
  /** reps added on the rows that progress by reps (+1), 0 otherwise */
  repDelta: number;
  reason: string;
  /** one target per working set of last time (same setNo + side); rir is last time's, only on rows where load AND reps are unchanged
   *  (a bare ✓ saves it, so an invented effort must never raise e1RM) */
  rows: (ProgressionSet & { lastLoadKg: number; lastReps: number })[];
}

/** Double progression with an RIR brake — the rule behind the greyed "today" numbers.
 *
 *  This is a coaching CONVENTION (the classic "double progression" used by apps such as Alpha Progression), not a
 *  formula from a trial: no study validates these exact thresholds, so the UI labels it a rough guide. Effort is read on
 *  the RIR-based RPE scale (Zourdos et al. 2016, JSCR 30(1):267–275; Helms et al. 2016, Strength Cond J 38(4):42–49).
 *  Background only: adjusting load by RIR instead of fixed loading has been studied (Graham & Cleather 2021, JSCR
 *  35(9):2451–2456), but not this specific rule.
 *
 *  Input: last session's done WORKING sets of the exercise (warm-ups and drop steps excluded), every side of one-side
 *  exercises (both sides must qualify). Range lo–hi from the slot; only lo given → lo = hi. Effort missing (not logged,
 *  or the RIR column off) → decide on reps alone.
 *  1. increase: every set reached ≥ hi reps, each with RIR ≥ TARGET_RIR (or no RIR) → load + one equipment step on
 *     every row, reps = lo. Assisted: one step less assistance (never below 0). Bodyweight with no added weight on any
 *     set → no weight to add, so reps + 1 instead (decision "reps", may go above hi).
 *  2. reduce: more than half the sets fell below lo → load − one step (assisted: + step), reps = lo. If the load is
 *     already 0 (nothing to take off) → hold instead.
 *  3. reps: otherwise same load; each row: below lo → lo; at/over hi → hi; else +1 rep, except a set taken to failure
 *     (RIR 0) repeats its reps. If no row changes (e.g. top of range but at RIR 0) → hold.
 *  Mixed weights across sets (pyramids, back-offs) keep their shape: the same step is added to each row's own load.
 *  Returns null without history or without a rep range (callers fall back to last time's numbers). */
export function progressionTarget(last: ProgressionSet[], repsMin: number | undefined | null, repsMax: number | undefined | null,
  stepKg: number, loadType: LoadType): ProgressionTarget | null {
  const sets = last.filter((s) => s.reps > 0);
  if (!sets.length || repsMin == null) return null;
  const lo = repsMin, hi = Math.max(repsMin, repsMax ?? repsMin);
  const easyEnough = (s: ProgressionSet) => s.rir == null || s.rir >= TARGET_RIR;
  const row = (s: ProgressionSet, loadKg: number, reps: number, keepRir: boolean) =>
    ({ setNo: s.setNo, side: s.side, loadKg: Math.max(0, loadKg), reps, rir: keepRir && reps === s.reps && loadKg === s.loadKg ? s.rir : null, lastLoadKg: s.loadKg, lastReps: s.reps });
  const heavier = loadType === 'assisted' ? -stepKg : stepKg; // load change that makes the lift heavier

  if (sets.every((s) => s.reps >= hi && easyEnough(s))) {
    if (loadType === 'bodyweight' && sets.every((s) => s.loadKg === 0))
      return { decision: 'reps', loadDeltaKg: 0, repDelta: 1, reason: `Top of ${lo}–${hi} reached with no added weight: one more rep (or add weight).`,
        rows: sets.map((s) => row(s, 0, s.reps + 1, true)) };
    if (loadType === 'assisted' && sets.every((s) => s.loadKg === 0))
      return { decision: 'reps', loadDeltaKg: 0, repDelta: 1, reason: `Top of ${lo}–${hi} reached with no assistance left: one more rep.`,
        rows: sets.map((s) => row(s, 0, s.reps + 1, true)) };
    return { decision: 'increase', loadDeltaKg: heavier, repDelta: 0,
      reason: `Every set reached the top of ${lo}–${hi} reps${sets.some((s) => s.rir != null) ? ` with ≥ ${TARGET_RIR} rep in reserve` : ''}: add one step and start again at ${lo}.`,
      rows: sets.map((s) => row(s, s.loadKg + heavier, lo, false)) };
  }
  const short = sets.filter((s) => s.reps < lo).length;
  if (short * 2 > sets.length) {
    const canLighten = loadType === 'assisted' || sets.some((s) => s.loadKg > 0);
    if (canLighten) return { decision: 'reduce', loadDeltaKg: -heavier, repDelta: 0,
      reason: `Most sets fell below ${lo} reps: one step lighter, aim for ${lo}.`,
      rows: sets.map((s) => row(s, s.loadKg - heavier, lo, false)) };
  }
  const rows = sets.map((s) => row(s, s.loadKg, s.reps < lo ? lo : s.reps >= hi ? hi : s.rir === 0 ? s.reps : s.reps + 1, true));
  const grows = rows.some((r) => r.reps > r.lastReps);
  if (!grows) return { decision: 'hold', loadDeltaKg: 0, repDelta: 0,
    reason: `Top of ${lo}–${hi} reached but at failure (0 in reserve): repeat it, then add weight.`, rows };
  return { decision: 'reps', loadDeltaKg: 0, repDelta: 1, reason: `Within ${lo}–${hi} reps: same weight, one more rep per set (sets at failure repeat).`, rows };
}
