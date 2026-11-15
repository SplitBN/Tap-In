// Every formula here must be listed in docs/SPEC.md → "Science sources".
// Rule: verify the cited source before changing a formula.

import type { LoadType, Mechanic, Unit } from '../db/types';

export const KG_PER_LB = 0.45359237; // exact, by definition (international pound, 1959)
export const toKg = (v: number, unit: Unit) => (unit === 'kg' ? v : v * KG_PER_LB);
export const fromKg = (kg: number, unit: Unit) => (unit === 'kg' ? kg : kg / KG_PER_LB);

/** RIR-based RPE scale: RPE 10 = 0 reps in reserve, RPE 9 = 1 RIR, ...; half steps allowed.
 *  Zourdos et al. 2016, J Strength Cond Res 30(1):267–275; Helms et al. 2016, Strength Cond J 38(4):42–49. */
export const rpeToRir = (rpe: number) => Math.max(0, 10 - rpe);
export const rirToRpe = (rir: number) => Math.min(10, Math.max(1, 10 - rir));

/** Total load actually moved, kg. Bodyweight exercises add the bodyweight snapshot. */
export function totalLoadKg(loadType: LoadType, loadKg: number | null | undefined, bodyweightKg: number | null | undefined) {
  const l = loadKg ?? 0;
  if (loadType === 'weighted') return l;
  const bw = bodyweightKg ?? 0;
  return loadType === 'assisted' ? bw - l : bw + l;
}

/** Estimated 1RM from a submaximal set.
 *  Reps-to-failure = reps + RIR (Helms et al. 2016), then Epley (1985): w·(1 + r/30).
 *  Accuracy drops beyond ~10 reps to failure (Reynolds, Gordon & Robergs 2006, JSCR 20(3):584–592),
 *  so `reliable` flags estimates from ≤ 10 reps-to-failure. */
export function e1rm(weightKg: number, reps: number, rir = 0) {
  const r = reps + rir;
  if (r <= 0 || weightKg <= 0) return { kg: 0, reliable: false };
  const kg = r === 1 ? weightKg : weightKg * (1 + r / 30);
  return { kg, reliable: r <= 10 };
}

/** Weight you could lift for n reps at failure, inverting Epley. */
export const nRepMax = (oneRm: number, n: number) => (n <= 1 ? oneRm : oneRm / (1 + n / 30));

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
