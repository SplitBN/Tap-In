// Nutrition math. Every formula is listed in docs/SPEC.md → "Science sources" (verified 2026-11-15).
import type { Activity, Macros, Sex } from '../db/types';

/** Resting energy expenditure, kcal/day.
 *  Mifflin MD, St Jeor ST, et al. 1990, Am J Clin Nutr 51(2):241–247:
 *  10·kg + 6.25·cm − 5·age + 5 (male) / − 161 (female). */
export function mifflinStJeor(sex: Sex, kg: number, cm: number, age: number) {
  return 10 * kg + 6.25 * cm - 5 * age + (sex === 'male' ? 5 : -161);
}

/** Physical activity level (TEE = BMR × PAL). Category ranges from FAO/WHO/UNU 2004,
 *  "Human energy requirements", Table 5.3: sedentary/light 1.40–1.69, active 1.70–1.99,
 *  vigorous 2.00–2.40. We use the lower bound for "sedentary" and range midpoints otherwise.
 *  A starting estimate only — adaptive maintenance replaces it once there's enough data. */
export const PAL: Record<Activity, number> = { sedentary: 1.4, light: 1.55, active: 1.85, very: 2.2 };
export const ACTIVITY_LABEL: Record<Activity, string> = {
  sedentary: 'Mostly sitting', light: 'Light', active: 'Active', very: 'Very active',
};

/** Energy density of body-mass change, kcal/kg. ~7700 is the common rule of thumb; Hall 2008
 *  (Int J Obes 32:573–576) shows the true value varies with body composition — a simplification. */
export const KCAL_PER_KG = 7700;

export const estimateMaintenance = (sex: Sex, kg: number, cm: number, age: number, act: Activity) =>
  Math.round((mifflinStJeor(sex, kg, cm, age) * PAL[act]) / 10) * 10;

/** Daily calorie target from maintenance and a weekly rate (kg/week, negative = lose). */
export const targetKcal = (maintenance: number, rateKgPerWeek: number) =>
  Math.round((maintenance + (rateKgPerWeek * KCAL_PER_KG) / 7) / 10) * 10;

/** Default protein: 1.6 g/kg/day — beyond ~1.62 g/kg/day protein gave no further resistance-training
 *  gains in fat-free mass (Morton RW et al. 2018, Br J Sports Med 52(6):376–384). */
export const PROTEIN_G_PER_KG = 1.6;

export const ZERO: Macros = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0 };
export function scale(per100: Macros, grams: number): Macros {
  const k = grams / 100;
  return { kcal: per100.kcal * k, p: per100.p * k, c: per100.c * k, f: per100.f * k, fiber: (per100.fiber ?? 0) * k };
}
export function sum(list: Macros[]): Macros {
  return list.reduce((a, m) => ({ kcal: a.kcal + m.kcal, p: a.p + m.p, c: a.c + m.c, f: a.f + m.f, fiber: (a.fiber ?? 0) + (m.fiber ?? 0) }), { ...ZERO });
}

/** Local calendar date key, YYYY-MM-DD (not UTC — a late dinner stays on its day). */
export function dateKey(d: Date | number = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function shiftDate(key: string, days: number) {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days));
}
export function keyToDate(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Calorie goal counts as hit within ±10% of target (our own tolerance, not a published standard). */
export const goalHit = (eaten: Macros, kcal: number, proteinG: number) =>
  eaten.kcal > 0 && Math.abs(eaten.kcal - kcal) <= kcal * 0.1 && eaten.p >= proteinG * 0.95;
