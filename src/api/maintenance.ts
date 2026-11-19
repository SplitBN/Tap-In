// Adaptive maintenance commands. The math is in src/lib/maintenance.ts (sources in docs/SPEC.md → "Science sources").
import { z } from 'zod';
import { defineCommand, zDate } from './registry';
import { alive, db, newRecord, save } from '../db/db';
import { goalFor } from '../db/food';
import { dayStatusRange } from './food';
import { getSettings } from '../db/settings';
import type { NutritionGoal } from '../db/types';
import { MAINT, adaptiveMaintenance, latestCleanKg } from '../lib/maintenance';
import { dateKey, estimateMaintenance, keyToDate, shiftDate, targetKcal } from '../lib/nutrition';

const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

export const maintenanceEstimate = defineCommand({ name: 'maintenance.estimate', kind: 'query',
  description: 'Maintenance calories (TDEE) estimated from your own logs by energy balance: mean intake on complete days − weight-trend change × 7700 kcal/kg, over a trailing window (default 28 days ending asOf). ' +
    'Noise rules: only days whose status is complete count (days.status: inferred from the log, or confirmed by the user); partial / unsure / not-yet-closed days are excluded with that reason; days < 800 kcal, > 2.5× the formula estimate, or robust outliers (median ± 3.5 MAD) are excluded with a reason; weigh-ins are one per day, typos (outside 25–350 kg) and jumps > max(2 kg, 3%) from nearby days are ignored; ' +
    'the trend is a robust Theil–Sen line. The data estimate is blended toward the Mifflin-St Jeor × activity formula by its precision and may move at most 75 kcal/day. ' +
    'source: "formula" (not enough data or feature off), "blended" (data counts < 75%, or easing back to the formula after data thinned out), "adaptive". confidence none|low|medium|high. manualKcal = a manual override in force in the goal (it wins over this estimate). ' +
    'series = per day in the window: logged intake, whether used or why excluded, the day\'s weigh-in (or why ignored), EWMA-smoothed weight and the trend line. history = the estimate for each of the last 57 days. A rough guide, not a measurement.',
  input: z.object({ asOf: zDate.optional().describe('Window end date, default today'), windowDays: z.number().int().min(14).max(42).default(MAINT.windowDays),
    formulaKcal: z.number().min(800).max(8000).optional().describe('Override the formula estimate used as the starting point (default: from the goal profile and latest clean weigh-in)') }),
  run: async ({ asOf, windowDays, formulaKcal }) => {
    const to = asOf ?? dateKey();
    const lo = shiftDate(to, -(windowDays - 1) - MAINT.replayDays - 1);
    const [goal, settings, entries, days, weights] = await Promise.all([
      goalFor(to),
      getSettings(),
      db.entries.where('date').between(lo, to, true, true).filter(alive).toArray(),
      dayStatusRange(lo, to),
      db.bodyweight.where('at').between(keyToDate(shiftDate(lo, -MAINT.neighbourDays)).getTime(), keyToDate(shiftDate(to, 1)).getTime()).filter(alive).toArray(),
    ]);
    const enabled = settings.features.adaptiveMaintenance !== false;
    const intake = new Map<string, number>();
    for (const e of entries) intake.set(e.date, (intake.get(e.date) ?? 0) + e.n.kcal);
    // complete = the inferred day status (or the user's confirmation); everything else is excluded with its reason
    const complete = new Set(days.filter((d) => d.status === 'complete').map((d) => d.date));
    const incomplete = new Map(days.filter((d) => d.status !== 'complete' && d.status !== 'empty')
      .map((d) => [d.date, d.status === 'open' ? 'not yet closed' as const : d.status === 'unsure' ? 'unsure day' as const : 'partial day' as const]));
    const weighIns = weights.map((w) => ({ at: w.at, kg: w.kg }));
    const kg = latestCleanKg(weighIns, to) ?? (await db.bodyweight.orderBy('at').reverse().filter(alive).first())?.kg ?? 80;
    const age = keyToDate(to).getFullYear() - (goal?.birthYear ?? 1995);
    const formula = formulaKcal ?? estimateMaintenance(goal?.sex ?? 'male', kg, goal?.heightCm ?? 175, age, goal?.activity ?? 'light');
    const r = adaptiveMaintenance({ asOf: to, windowDays, intake, complete, incomplete, weighIns, formulaKcal: formula });
    const e = r.est;
    const off = !enabled;
    return {
      kcal: off ? formula : r.kcal,
      source: off ? 'formula' as const : r.source,
      confidence: off ? 'none' as const : r.confidence,
      plusMinusKcal: off || !e.ok ? null : Math.round(e.posteriorSd! / 10) * 10,
      enabled, profileSet: !!goal,
      manualKcal: goal?.maintenanceSource === 'manual' ? goal.maintenanceKcal : null,
      formulaKcal: formula, formulaWeightKg: kg,
      window: { from: e.from, to: e.to, days: windowDays },
      enoughData: e.ok, needs: e.missing,
      intakeDays: e.intakeDays, meanIntakeKcal: e.meanIntake == null ? null : Math.round(e.meanIntake),
      excludedDays: r.series.filter((d) => d.intakeExcluded).map((d) => ({ date: d.date, kcal: d.intakeKcal, reason: d.intakeExcluded! })),
      weighIns: e.weighIns, weighInSpanDays: e.spanDays,
      ignoredWeighIns: r.series.filter((d) => d.weighInExcluded).map((d) => ({ date: d.date, kg: d.weighInKg, reason: d.weighInExcluded! })),
      trendStartKg: r2(e.trendStartKg), trendEndKg: r2(e.trendEndKg), trendKgPerWeek: e.slopeKgPerDay == null ? null : r2(e.slopeKgPerDay * 7),
      dataKcal: e.dataKcal == null ? null : Math.round(e.dataKcal), dataWeight: r2(e.weight),
      series: r.series, history: r.history,
    };
  } });

export const maintenanceApply = defineCommand({ name: 'maintenance.apply', kind: 'action',
  description: 'Accept the log-based maintenance (maintenance.estimate) into today\'s nutrition goal: stores maintenanceKcal with maintenanceSource "adaptive" (replacing a manual override or the formula value). ' +
    'updateTarget (default true) also resets the calorie target to maintenance + weekly rate × 7700 / 7 (only if a calorie target is on). Older days keep their goals. Fails when there is not enough data or the feature is off. Returns the saved goal.',
  input: z.object({ maintenanceKcal: z.number().min(800).max(8000).optional().describe('Value to store; default = the current estimate'), updateTarget: z.boolean().default(true) }),
  run: async ({ maintenanceKcal, updateTarget }) => {
    const today = dateKey();
    const cur = await goalFor(today);
    if (!cur) throw new Error('Set up goals first (goals.set)');
    let m = maintenanceKcal;
    if (m == null) {
      const est = await maintenanceEstimate.run(maintenanceEstimate.input.parse({}));
      if (est.source === 'formula') throw new Error(est.enabled ? `Not enough data yet: needs ${est.needs.join(', ')}` : 'Adaptive maintenance is turned off in Settings');
      m = est.kcal;
    }
    const fields: Partial<NutritionGoal> = { maintenanceKcal: m, maintenanceSource: 'adaptive', ...(updateTarget && cur.kcal != null ? { kcal: targetKcal(m, cur.rateKgPerWeek) } : {}) };
    const same = await db.goals.where('effectiveFrom').equals(today).filter(alive).first();
    if (same) return save('goals', { ...same, ...fields });
    const { id: _id, createdAt: _c, updatedAt: _u, deletedAt: _d, ...copy } = cur;
    return save('goals', newRecord({ ...copy, ...fields, effectiveFrom: today }) as NutritionGoal);
  } });
