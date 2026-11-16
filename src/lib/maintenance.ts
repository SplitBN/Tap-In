// Adaptive maintenance: estimate real maintenance calories (TDEE) from logged intake and the bodyweight trend
// (energy balance). Pure functions on raw facts. Nothing here is stored, it's computed on read.
// Every rule and constant is listed in docs/SPEC.md → "Science sources" → "Adaptive maintenance" rows.
//
// Method, per trailing window (default 28 days ending on `asOf`):
//  1. Intake: only days marked "fully logged" count. A missing day is never 0 kcal. Complete days that are
//     implausible are dropped: < 800 kcal, > 2.5 × the formula estimate, or a robust outlier
//     (modified z-score |0.6745·(x − median)/MAD| > 3.5, Iglewicz & Hoaglin 1993, as given in the NIST/SEMATECH
//     e-Handbook §1.3.5.17; scale floored at 20% of the median, so a very regular eater only loses days > 70% above their median).
//  2. Weight: one value per day (median of that day's weigh-ins). Values outside 25–350 kg are typos. A day
//     more than max(2 kg, 3%) away from the median of its neighbours within ±7 days is a likely logging
//     mistake (our own rule). Cleaning happens before any smoothing.
//  3. Trend: Theil–Sen line through the clean weigh-ins in the window (median of pairwise slopes; Sen 1968,
//     JASA 63(324):1379–1389). Robust to leftover water spikes, handles gaps, and has no EWMA lag. Trend start/end
//     and kg/week come from this line. The EWMA series (Hacker's Diet style, 10%/day) is returned per day for the agent only (it lags, so it isn't drawn).
//  4. Data estimate: TDEE ≈ mean intake − slope (kg/day) × 7700 kcal/kg (Hall 2008, Int J Obes 32:573–576,
//     ≈ 32.2 MJ/kg; Hall shows this overstates the energy in weight change for people with < ~30 kg body fat).
//  5. Shrinkage toward the formula (normal–normal precision weighting): w = τ²/(τ² + SE²), with
//     SE² = SD(intake)²/n + (7700 · SE(slope))² and τ = 15% of the formula estimate (our convention; Mifflin-St Jeor
//     alone is within ±10% of measured RMR for most adults, Frankenfield et al. 2005, and PAL adds more).
//  6. Stability: the estimate is replayed day by day and may move at most 75 kcal per day (≈ 500/week; our convention),
//     also when data thins out (it eases back to the formula instead of jumping).
import { dateKey, keyToDate, shiftDate } from './nutrition';

export const KCAL_PER_KG_CHANGE = 7700; // Hall 2008: 3500 kcal/lb ≈ 32.2 MJ/kg ≈ 7700 kcal/kg
export const MAINT = {
  windowDays: 28,
  minIntakeDays: 10,
  minWeighIns: 5,
  minSpanDays: 10,
  minKcal: 800,
  maxKcalFactor: 2.5,
  madZ: 3.5, // Iglewicz & Hoaglin 1993
  madFloorFrac: 0.2,
  jumpKg: 2,
  jumpFrac: 0.03,
  neighbourDays: 7,
  minKg: 25,
  maxKg: 350,
  priorFrac: 0.15, // τ = 15% of the formula estimate
  minResidualKg: 0.3, // floor on day-to-day scatter so a few lucky weigh-ins don't look precise
  capPerDay: 75,
  replayDays: 56,
  ewmaAlpha: 0.1, // The Hacker's Diet (Walker): trend += 10% of the difference each day
  adaptiveWeight: 0.75, // w at or above this → "adaptive", below → "blended"
} as const;

export interface WeighIn { at: number; kg: number }
export type IntakeExclusion = 'not marked fully logged' | 'under 800 kcal' | 'over 2.5× estimate' | 'outlier vs your usual intake';
export type WeightExclusion = 'implausible weight' | 'jump vs nearby weigh-ins';

export interface DayRow {
  date: string;
  intakeKcal: number | null; // logged total (null = nothing logged)
  intakeUsed: boolean;
  intakeExcluded?: IntakeExclusion;
  weighInKg: number | null; // median of that day's weigh-ins
  weighInExcluded?: WeightExclusion;
  smoothedKg: number | null; // EWMA of clean weigh-ins (display)
  trendKg: number | null; // Theil–Sen line (what the estimate uses)
}

export interface WindowEstimate {
  ok: boolean; // enough data
  missing: string[]; // why not, when !ok
  from: string; to: string;
  intakeDays: number; meanIntake: number | null; sdIntake: number | null;
  weighIns: number; spanDays: number;
  slopeKgPerDay: number | null; slopeSe: number | null; trendStartKg: number | null; trendEndKg: number | null;
  dataKcal: number | null; dataSe: number | null; // the raw energy-balance estimate and its standard error
  weight: number; // shrinkage weight on the data (0 = formula only)
  blendedKcal: number; posteriorSd: number | null;
}

const DAY = 86400000;
export const dayDiff = (a: string, b: string) => Math.round((keyToDate(b).getTime() - keyToDate(a).getTime()) / DAY);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const r10 = (v: number) => Math.round(v / 10) * 10;

/** One value per local day (median of that day's weigh-ins), then typo/jump filtering. */
export function cleanWeighIns(raw: WeighIn[]) {
  const byDay = new Map<string, number[]>();
  for (const w of raw) { const k = dateKey(w.at); byDay.set(k, [...(byDay.get(k) ?? []), w.kg]); }
  const days = [...byDay.entries()].map(([date, kgs]) => ({ date, kg: median(kgs) })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const status = new Map<string, WeightExclusion | null>();
  for (const d of days) status.set(d.date, d.kg < MAINT.minKg || d.kg > MAINT.maxKg ? 'implausible weight' : null);
  const plausible = days.filter((d) => !status.get(d.date));
  for (const d of plausible) {
    const near = plausible.filter((o) => o !== d && Math.abs(dayDiff(o.date, d.date)) <= MAINT.neighbourDays).map((o) => o.kg);
    if (near.length < 2) continue; // not enough context to call it a mistake
    const ref = median(near);
    if (Math.abs(d.kg - ref) > Math.max(MAINT.jumpKg, MAINT.jumpFrac * ref)) status.set(d.date, 'jump vs nearby weigh-ins');
  }
  return days.map((d) => ({ ...d, excluded: status.get(d.date) ?? undefined }));
}
export type CleanDay = ReturnType<typeof cleanWeighIns>[number];

/** Theil–Sen line (Sen 1968): slope = median of pairwise slopes, intercept = median(y − slope·t).
 *  SE of the slope from the residual scatter (OLS formula, residual SD floored), used only for weighting. */
export function theilSen(pts: { t: number; y: number }[]) {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[j].t !== pts[i].t) slopes.push((pts[j].y - pts[i].y) / (pts[j].t - pts[i].t));
  const b = slopes.length ? median(slopes) : 0;
  const a = median(pts.map((p) => p.y - b * p.t));
  const tm = mean(pts.map((p) => p.t));
  const sxx = pts.reduce((s, p) => s + (p.t - tm) ** 2, 0);
  const rss = pts.reduce((s, p) => s + (p.y - (a + b * p.t)) ** 2, 0);
  const resid = Math.max(MAINT.minResidualKg, Math.sqrt(rss / Math.max(1, pts.length - 2)));
  return { a, b, se: sxx > 0 ? resid / Math.sqrt(sxx) : Infinity };
}

/** Exponentially smoothed weight on a daily grid (Walker, The Hacker's Diet: 10% per day). A weigh-in after a gap of
 *  g days gets weight 1 − 0.9^g (as if the trend had been nudged each missed day); days without one hold the trend. */
export function ewmaSeries(clean: CleanDay[], from: string, to: string) {
  const good = clean.filter((d) => !d.excluded);
  const out = new Map<string, number>();
  if (!good.length) return out;
  const obs = new Map(good.map((d) => [d.date, d.kg]));
  let trend: number | null = null, last = '';
  for (let k = good[0].date; k <= to; k = shiftDate(k, 1)) {
    const v = obs.get(k);
    if (v != null) {
      if (trend == null) trend = v;
      else { const g = Math.max(1, dayDiff(last, k)); trend += (1 - (1 - MAINT.ewmaAlpha) ** g) * (v - trend); }
      last = k;
    }
    if (trend != null && k >= from) out.set(k, trend);
  }
  return out;
}

/** Intake rules for one window. complete days only; hard bounds first, then the robust outlier rule. */
export function classifyIntake(dates: string[], intake: Map<string, number>, complete: Set<string>, formulaKcal: number) {
  const res = new Map<string, IntakeExclusion | null>();
  const pass: string[] = [];
  for (const d of dates) {
    const k = intake.get(d) ?? 0;
    if (!complete.has(d)) { if (intake.has(d)) res.set(d, 'not marked fully logged'); continue; }
    if (k < MAINT.minKcal) res.set(d, 'under 800 kcal');
    else if (k > MAINT.maxKcalFactor * formulaKcal) res.set(d, 'over 2.5× estimate');
    else { res.set(d, null); pass.push(d); }
  }
  if (pass.length >= 7) {
    const xs = pass.map((d) => intake.get(d) ?? 0);
    const m = median(xs);
    const scale = Math.max(1.4826 * median(xs.map((x) => Math.abs(x - m))), MAINT.madFloorFrac * m);
    for (const d of pass) if (Math.abs((intake.get(d) ?? 0) - m) / scale > MAINT.madZ) res.set(d, 'outlier vs your usual intake');
  }
  return res;
}

/** The energy-balance estimate for the window ending on `to`, blended toward the formula by its precision. */
export function windowEstimate(to: string, windowDays: number, intake: Map<string, number>, complete: Set<string>, clean: CleanDay[], formulaKcal: number): WindowEstimate & { intakeStatus: Map<string, IntakeExclusion | null> } {
  const from = shiftDate(to, -(windowDays - 1));
  const dates: string[] = [];
  for (let k = from; k <= to; k = shiftDate(k, 1)) dates.push(k);
  const intakeStatus = classifyIntake(dates, intake, complete, formulaKcal);
  const used = dates.filter((d) => intakeStatus.get(d) === null).map((d) => intake.get(d) ?? 0);
  const w = clean.filter((d) => !d.excluded && d.date >= from && d.date <= to);
  const spanDays = w.length ? dayDiff(w[0].date, w[w.length - 1].date) : 0;
  const missing: string[] = [];
  if (used.length < MAINT.minIntakeDays) missing.push(`${MAINT.minIntakeDays} fully logged days (have ${used.length})`);
  if (w.length < MAINT.minWeighIns) missing.push(`${MAINT.minWeighIns} weigh-ins (have ${w.length})`);
  else if (spanDays < MAINT.minSpanDays) missing.push(`weigh-ins spread over ${MAINT.minSpanDays}+ days (have ${spanDays})`);
  const base = { from, to, intakeDays: used.length, meanIntake: used.length ? mean(used) : null, sdIntake: used.length ? sd(used) : null, weighIns: w.length, spanDays, intakeStatus };
  if (missing.length) return { ...base, ok: false, missing, slopeKgPerDay: null, slopeSe: null, trendStartKg: null, trendEndKg: null, dataKcal: null, dataSe: null, weight: 0, blendedKcal: formulaKcal, posteriorSd: null };
  const fit = theilSen(w.map((d) => ({ t: dayDiff(from, d.date), y: d.kg })));
  const dataKcal = base.meanIntake! - fit.b * KCAL_PER_KG_CHANGE;
  const dataSe = Math.sqrt((base.sdIntake! ** 2) / used.length + (KCAL_PER_KG_CHANGE * fit.se) ** 2);
  const tau = MAINT.priorFrac * formulaKcal;
  const weight = tau ** 2 / (tau ** 2 + dataSe ** 2);
  const blended = Math.min(6000, Math.max(1000, weight * dataKcal + (1 - weight) * formulaKcal));
  return { ...base, ok: true, missing, slopeKgPerDay: fit.b, slopeSe: fit.se, trendStartKg: fit.a, trendEndKg: fit.a + fit.b * (windowDays - 1),
    dataKcal, dataSe, weight, blendedKcal: blended, posteriorSd: Math.sqrt(1 / (1 / tau ** 2 + 1 / dataSe ** 2)) };
}

export type MaintSource = 'formula' | 'adaptive' | 'blended';
export type Confidence = 'none' | 'low' | 'medium' | 'high';

/** Full estimate as of a date: replays the window estimate day by day so it moves at most capPerDay kcal per day
 *  (after rounding to 10). A day without enough data eases back toward the formula at the same cap, never in one jump. */
export function adaptiveMaintenance(p: { asOf: string; windowDays?: number; intake: Map<string, number>; complete: Set<string>; weighIns: WeighIn[]; formulaKcal: number }) {
  const W = p.windowDays ?? MAINT.windowDays;
  const clean = cleanWeighIns(p.weighIns);
  const history: { date: string; kcal: number; source: MaintSource }[] = [];
  const f10 = r10(p.formulaKcal);
  let prev = f10;
  const cur = windowEstimate(p.asOf, W, p.intake, p.complete, clean, p.formulaKcal);
  for (let k = shiftDate(p.asOf, -MAINT.replayDays); k <= p.asOf; k = shiftDate(k, 1)) {
    const e = k === p.asOf ? cur : windowEstimate(k, W, p.intake, p.complete, clean, p.formulaKcal);
    const target = r10(e.ok ? e.blendedKcal : f10);
    // step to the target, or by the largest multiple of 10 within the cap
    prev = Math.abs(target - prev) <= MAINT.capPerDay ? target : prev + Math.sign(target - prev) * Math.floor(MAINT.capPerDay / 10) * 10;
    history.push({ date: k, kcal: prev, source: !e.ok ? (prev === f10 ? 'formula' : 'blended') : e.weight >= MAINT.adaptiveWeight ? 'adaptive' : 'blended' });
  }
  const last = history[history.length - 1];
  const source: MaintSource = last.source; // not enough data but still easing back → 'blended'
  const confidence: Confidence = source === 'formula' ? 'none' : !cur.ok ? 'low' : cur.dataSe! <= 150 ? 'high' : cur.dataSe! <= 300 ? 'medium' : 'low';
  // per-day series for the window (agent + "how" sheet)
  const ew = ewmaSeries(clean, cur.from, p.asOf);
  const cleanByDay = new Map(clean.map((d) => [d.date, d]));
  const series: DayRow[] = [];
  for (let k = cur.from; k <= p.asOf; k = shiftDate(k, 1)) {
    const st = cur.intakeStatus.get(k);
    const wd = cleanByDay.get(k);
    series.push({
      date: k, intakeKcal: p.intake.has(k) ? Math.round(p.intake.get(k)!) : null, intakeUsed: st === null, ...(st ? { intakeExcluded: st } : {}),
      weighInKg: wd ? Math.round(wd.kg * 100) / 100 : null, ...(wd?.excluded ? { weighInExcluded: wd.excluded } : {}),
      smoothedKg: ew.has(k) ? Math.round(ew.get(k)! * 100) / 100 : null,
      trendKg: cur.ok ? Math.round((cur.trendStartKg! + cur.slopeKgPerDay! * dayDiff(cur.from, k)) * 100) / 100 : null,
    });
  }
  const cleanKg = [...clean].reverse().find((d) => !d.excluded && d.date <= p.asOf)?.kg ?? null;
  return { kcal: last.kcal, source, confidence, est: cur, history, series, clean, cleanKg };
}

/** Latest plausible weigh-in on or before a date (typos and jumps skipped), for the formula's weight input. */
export function latestCleanKg(weighIns: WeighIn[], asOf: string) {
  return [...cleanWeighIns(weighIns)].reverse().find((d) => !d.excluded && d.date <= asOf)?.kg ?? null;
}
