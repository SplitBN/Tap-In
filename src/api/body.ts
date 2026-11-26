import { z } from 'zod';
import { defineCommand, zDate, zId, zTime } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import { buildDay, doseOn, logTake, nextSite, scheduleText, stockForecast, stockText, undoTake } from '../db/supps';
import { getSettings, updateSettings } from '../db/settings';
import type { DoseStep, Note, Schedule, Settings, Stack, SuppForm, SuppLog, SuppRoute, Supplement } from '../db/types';
import { BACKUP_TABLES, buildBackup, restoreBackup } from '../lib/backup';
import { dateKey, keyToDate } from '../lib/nutrition';
import { cleanWeighIns, ewmaSeries } from '../lib/maintenance';
import { GAP_DAYS } from '../lib/series';

// ---------------- bodyweight ----------------
export const weightLog = defineCommand({ name: 'bodyweight.log', kind: 'action', description: 'Log a new weigh-in in kg (at = ISO time, defaults to now). Returns the saved entry (id, at in ms, kg).',
  input: z.object({ kg: z.number().min(20).max(400), at: z.string().datetime({ offset: true }).optional(), note: z.string().optional() }),
  run: async ({ kg, at, note }) => save('bodyweight', newRecord({ kg, at: at ? Date.parse(at) : Date.now(), ...(note?.trim() ? { note: note.trim() } : {}) })) });
export const weightUpdate = defineCommand({ name: 'bodyweight.update', kind: 'action', description: 'Correct an existing weigh-in: its weight, its time and/or its note (note "" clears it). Returns the saved entry.',
  input: z.object({ id: zId, kg: z.number().min(20).max(400).optional(), at: z.string().datetime({ offset: true }).optional(), note: z.string().optional() }),
  run: async ({ id, kg, at, note }) => { const e = await db.bodyweight.get(id); if (!e || !alive(e)) throw new Error('Weigh-in not found');
    return save('bodyweight', { ...e, kg: kg ?? e.kg, at: at ? Date.parse(at) : e.at, note: note === undefined ? e.note : note.trim() || undefined }); } });
export const weightDelete = defineCommand({ name: 'bodyweight.delete', kind: 'action', description: 'Delete a weigh-in.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('bodyweight', id); return { ok: true }; } });
// undo for deletes: records are soft-deleted (they sync), so undo clears the marker on the same id
const RESTORABLE = ['bodyweight', 'entries', 'stacks', 'notes', 'supplements', 'foods'] as const;
export const recordsRestore = defineCommand({ name: 'records.restore', kind: 'action',
  description: 'Undo a delete: bring back a deleted weigh-in (bodyweight), food log entry (entries), stack, journal note, supplement or own food by its id. Returns the restored record.',
  input: z.object({ table: z.enum(RESTORABLE), id: zId }),
  run: async ({ table, id }) => {
    const rec = await db.table(table).get(id);
    if (!rec) throw new Error(`No ${table} record with id "${id}"`);
    return rec.deletedAt ? save(table, { ...rec, deletedAt: null }) : rec;
  } });
export const weightList = defineCommand({ name: 'bodyweight.list', kind: 'query', description: 'Weigh-ins between dates (inclusive), oldest first.',
  input: z.object({ from: zDate.optional(), to: zDate.optional() }),
  run: async ({ from, to }) => (await db.bodyweight.where('at').between(from ? keyToDate(from).getTime() : 0, to ? keyToDate(to).getTime() + 86400000 : Date.now() + 86400000).filter(alive).sortBy('at'))
    .map((e) => ({ id: e.id, date: dateKey(e.at), at: new Date(e.at).toISOString(), kg: e.kg, note: e.note })) });

export const weightSeries = defineCommand({ name: 'bodyweight.series', kind: 'query',
  description: 'Weigh-ins with the display trend, oldest first (points[]: id, date, at ms, kg, trendKg, excluded). Chart-ready, use as a show_chart source. ' +
    'trendKg = the app’s display trend: exponentially smoothed clean daily weight (10%/day, gaps weighted 1 − 0.9^days; The Hacker’s Diet), computed over all history. ' +
    'excluded = why a weigh-in is ignored by the trend (typo outside 25–350 kg, or a jump > max(2 kg, 3%) from nearby days), same rules as maintenance.estimate. ' +
    'Optional from/to dates filter the rows (the trend still uses all history). gapDays = the line-break threshold the app draws. Not the 28-day Theil–Sen line maintenance.estimate uses.',
  input: z.object({ from: zDate.optional(), to: zDate.optional() }),
  run: async ({ from, to }) => {
    const all = await db.bodyweight.orderBy('at').filter(alive).toArray();
    const clean = cleanWeighIns(all.map((w) => ({ at: w.at, kg: w.kg })));
    const ex = new Map(clean.map((d) => [d.date, d.excluded]));
    const trend = all.length ? ewmaSeries(clean, dateKey(all[0].at), dateKey(all[all.length - 1].at)) : new Map<string, number>();
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const points = all.map((w) => { const d = dateKey(w.at); const t = trend.get(d);
      return { id: w.id, date: d, at: w.at, kg: r2(w.kg), trendKg: t == null ? null : r2(t), excluded: ex.get(d) ?? null }; })
      .filter((p) => (!from || p.date >= from) && (!to || p.date <= to));
    return { unit: 'kg' as const, gapDays: GAP_DAYS, points };
  } });

// ---------------- supplements ----------------
const zSchedule = z.object({
  kind: z.enum(['daily', 'weekdays', 'interval', 'weekly', 'asNeeded']),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('weekdays 0=Sun..6=Sat, for kind "weekdays"'),
  every: z.number().int().min(2).optional().describe('every N days, for kind "interval"'),
  times: z.array(zTime).optional().describe('times of day it is due (sorted automatically, emptied for asNeeded). Default ["08:00"] when creating'),
  startDate: zDate.optional().describe('first day (default today). kind "weekly" repeats on the weekday of this date; "interval" counts from it; cycles start here'),
  cycle: z.object({ onDays: z.number().int().min(1), offDays: z.number().int().min(0) }).nullable().optional().describe('on/off cycle counted from startDate; null removes it'),
});
const zDoseStep = z.object({ from: zDate, amount: z.number().positive() });
const suppView = (s: Supplement, todayLogs: SuppLog[] = []) => {
  const f = stockForecast(s, dateKey(), todayLogs);
  return { id: s.id, name: s.name, form: s.form, route: s.route, unit: s.unit, currentDose: doseOn(s, dateKey()), doseHistory: s.doses,
    schedule: s.schedule, scheduleText: scheduleText(s.schedule), stock: s.stock ?? null, lowStock: s.lowStock === undefined ? 'default' as const : s.lowStock,
    stockDaysLeft: f?.daysLeft ?? null, stockRunsOutOn: f?.runsOutOn ?? null, stockLow: f?.low ?? false, notes: s.notes, archived: !!s.archived };
};
const todaysLogs = () => db.supplogs.where('date').equals(dateKey()).filter(alive).toArray();
const zLowStock = z.object({ kind: z.enum(['days', 'amount']), value: z.number().min(0) }).nullable()
  .describe('Low-stock alert threshold: {kind:"days", value:N} = when the stock covers N days or fewer of scheduled doses; {kind:"amount", value:N} = when N or less (in the supplement unit) is left; null = no alert. Default when never set: 7 days');
const routeFor = (form: SuppForm): SuppRoute => (form === 'injection' ? 'subq' : form === 'other' ? 'other' : 'oral');
/** Normalise + validate a schedule: times sorted and de-duplicated, none for as-needed. */
function cleanSchedule(s: Schedule): Schedule {
  const out: Schedule = { ...s, times: s.kind === 'asNeeded' ? [] : [...new Set(s.times)].sort() };
  if (out.kind !== 'asNeeded' && !out.times.length) throw new Error('A scheduled supplement needs at least one time of day');
  if (out.kind === 'weekdays' && !(out.days ?? []).length) throw new Error('Schedule kind "weekdays" needs at least one day');
  if (out.kind === 'interval' && !out.every) out.every = 2;
  return out;
}
/** One step per date (last wins), oldest first. */
const cleanDoses = (doses: DoseStep[]) => [...new Map(doses.map((d) => [d.from, d] as const)).values()].sort((a, b) => a.from.localeCompare(b.from));

export const suppList = defineCommand({ name: 'supplements.list', kind: 'query',
  description: 'All supplements/medications/peptides with dose history, schedule and stock, plus stacks. Stock fields: stock (amount left in unit, null = not tracked), lowStock (alert threshold: "default" = 7 days, null = off), ' +
    'stockDaysLeft (days from today until the first scheduled day the stock cannot cover, from schedule + dose; null when untracked or as-needed; 400 = a year or more), stockRunsOutOn (that date), stockLow (at or below the threshold).',
  input: z.object({}), run: async () => ({
    supplements: await todaysLogs().then(async (logs) => (await db.supplements.filter(alive).toArray()).map((s) => suppView(s, logs))),
    stacks: (await db.stacks.filter(alive).toArray()).map((s) => ({ id: s.id, name: s.name, supplementIds: s.supplementIds })),
  }) });
export const suppSave = defineCommand({ name: 'supplements.save', kind: 'action',
  description: 'Create (no id) or update a supplement; on update only the fields you pass change. Creating needs name and dose (or doses); dose applies from the schedule startDate (or today if that is in the future). ' +
    'To titrate an existing one prefer supplements.changeDose (adds a step, keeps history); doses replaces the whole dose history (corrections, removing a wrong step). ' +
    'schedule is merged into the current one (cycle:null removes a cycle); times are sorted and emptied for asNeeded. route is derived from form (injection→subq, other→other, else oral) unless given. ' +
    'archived:true = "stop taking" (hidden from the checklist, history kept), false resumes. notes:"" clears notes, stock:null clears stock (to add a new pack prefer supplements.restock). lowStock sets the low-stock alert. Returns the saved supplement.',
  input: z.object({ id: zId.optional(), name: z.string().trim().min(1).optional(), form: z.enum(['capsule', 'tablet', 'powder', 'liquid', 'injection', 'other']).optional(),
    route: z.enum(['oral', 'subq', 'im', 'other']).optional(), unit: z.string().trim().min(1).optional(), dose: z.number().positive().optional().describe('starting dose, only when creating'),
    doses: z.array(zDoseStep).min(1).optional().describe('full dose history (replaces it): each step applies from its date on'),
    schedule: zSchedule.optional(), stock: z.number().min(0).nullable().optional(), lowStock: zLowStock.optional(), notes: z.string().optional(), archived: z.boolean().optional() }),
  run: async ({ id, dose, doses, schedule, notes, ...given }) => {
    const today = dateKey();
    const p = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as typeof given; // undefined = leave unchanged
    const notesPatch = notes === undefined ? {} : { notes: notes.trim() || undefined };
    if (id) {
      const s = await db.supplements.get(id); if (!s || !alive(s)) throw new Error('Supplement not found');
      const route = p.route ?? (p.form && p.form !== s.form ? routeFor(p.form) : s.route);
      const sched = schedule ? cleanSchedule({ ...s.schedule, ...schedule, times: schedule.times ?? s.schedule.times, startDate: schedule.startDate ?? s.schedule.startDate }) : s.schedule;
      return suppView(await save('supplements', { ...s, ...p, ...notesPatch, route, schedule: sched, doses: doses ? cleanDoses(doses) : s.doses } as Supplement), await todaysLogs());
    }
    if (!p.name || (dose == null && !doses)) throw new Error('name and dose are required to create');
    const form = p.form ?? 'capsule';
    const sched = cleanSchedule({ kind: 'daily', ...schedule, times: schedule?.times ?? ['08:00'], startDate: schedule?.startDate ?? today } as Schedule);
    return suppView(await save('supplements', newRecord({ name: p.name, form, route: p.route ?? routeFor(form), unit: p.unit ?? 'mg',
      doses: doses ? cleanDoses(doses) : [{ from: sched.startDate <= today ? sched.startDate : today, amount: dose! }],
      schedule: sched, stock: p.stock ?? null, ...(p.lowStock !== undefined ? { lowStock: p.lowStock } : {}), ...notesPatch, archived: p.archived ?? false }) as Supplement), await todaysLogs());
  } });
export const suppDose = defineCommand({ name: 'supplements.changeDose', kind: 'action', description: 'Change a dose from a date on (titration); earlier dose steps stay in history. If a step already starts on that exact date it is replaced (a correction).',
  input: z.object({ id: zId, amount: z.number().positive(), from: zDate.optional() }),
  run: async ({ id, amount, from }) => { const s = await db.supplements.get(id); if (!s || !alive(s)) throw new Error('Supplement not found');
    const d = from ?? dateKey(); return suppView(await save('supplements', { ...s, doses: cleanDoses([...s.doses.filter((x) => x.from !== d), { from: d, amount }]) }), await todaysLogs()); } });
export const suppDelete = defineCommand({ name: 'supplements.delete', kind: 'action', description: 'Delete a supplement (its logs stay for analysis). Prefer archived=true via supplements.save to "stop taking".',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('supplements', id); return { ok: true }; } });
export const suppRestock = defineCommand({ name: 'supplements.restock', kind: 'action',
  description: 'Add to a supplement stock (a new bottle/pen/pack arrived): amount is added in the supplement unit (stock that was not tracked starts at amount). To set an exact count use supplements.save stock. Returns the supplement with its new stock and days left.',
  input: z.object({ id: zId, amount: z.number().positive().describe('How much to add, in the supplement unit (e.g. 60 for 60 caps when the unit is caps, or 300 for 300 g)') }),
  run: async ({ id, amount }) => { const s = await db.supplements.get(id); if (!s || !alive(s)) throw new Error('Supplement not found');
    return suppView(await save('supplements', { ...s, stock: Math.round(((s.stock ?? 0) + amount) * 1000) / 1000 }), await todaysLogs()); } });
export const suppStock = defineCommand({ name: 'supplements.stockStatus', kind: 'query',
  description: 'Stock forecast for every active supplement whose stock is tracked: stock left, daysLeft (days from today until the first scheduled day it cannot cover; same rule the server uses for the low-stock push; null for as-needed), runsOutOn, threshold, low, and text (e.g. "~5 days left"). Low ones first.',
  input: z.object({}),
  run: async () => {
    const logs = await todaysLogs();
    return (await db.supplements.filter(alive).sortBy('name')).flatMap((s) => {
      const f = stockForecast(s, dateKey(), logs);
      return f ? [{ id: s.id, name: s.name, unit: s.unit, ...f, text: stockText(f, s.unit) }] : [];
    }).sort((a, b) => Number(b.low) - Number(a.low));
  } });
export const stackSave = defineCommand({ name: 'stacks.save', kind: 'action', description: 'Create (no id) or update a stack: supplements taken together; members due at the same time are grouped and checked off in one go. Returns the stack.',
  input: z.object({ id: zId.optional(), name: z.string().trim().min(1), supplementIds: z.array(zId).min(2) }),
  run: async ({ id, name, supplementIds }) => {
    const ids = [...new Set(supplementIds)]; if (ids.length < 2) throw new Error('A stack needs at least 2 different supplements');
    if (!id) return save('stacks', newRecord({ name, supplementIds: ids }) as Stack);
    const s = await db.stacks.get(id); if (!s || !alive(s)) throw new Error('Stack not found');
    return save('stacks', { ...s, name, supplementIds: ids });
  } });
export const stackDelete = defineCommand({ name: 'stacks.delete', kind: 'action', description: 'Delete a stack (the supplements themselves stay).',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('stacks', id); return { ok: true }; } });

export const suppDay = defineCommand({ name: 'supplements.day', kind: 'query', description: 'The checklist for a date: what was due at which time, the dose, and whether it was taken/skipped (with time and injection site).',
  input: z.object({ date: zDate.optional() }),
  run: async ({ date }) => {
    const d = date ?? dateKey();
    const [sups, stacks, logs] = await Promise.all([db.supplements.filter(alive).toArray(), db.stacks.filter(alive).toArray(), db.supplogs.where('date').equals(d).filter(alive).toArray()]);
    const view = (sup: Supplement, amount: number, log?: SuppLog) => ({ supplementId: sup.id, name: sup.name, dose: amount, unit: sup.unit, status: log?.status ?? 'due', takenAt: log?.takenAt ? new Date(log.takenAt).toISOString() : null, site: log?.site ?? null, logId: log?.id });
    const scheduled = buildDay(d, sups, stacks, logs).map((g) => ({ time: g.slot, groups: g.stacks.map((st) => ({ stack: st.stack?.name ?? null, items: st.items.map((i) => view(i.sup, i.amount, i.log)) })) }));
    // as-needed supplements are never "due"; list each one with every dose logged that day (status 'available' when none)
    const asNeeded = sups.filter((s) => !s.archived && s.schedule.kind === 'asNeeded').flatMap((s) => {
      const mine = logs.filter((l) => l.supplementId === s.id);
      return mine.length ? mine.map((l) => view(s, l.amount ?? doseOn(s, d), l)) : [{ ...view(s, doseOn(s, d)), status: 'available' }];
    });
    return asNeeded.length ? [...scheduled, { time: 'as needed', groups: [{ stack: null, items: asNeeded }] }] : scheduled;
  } });

/** Timestamp for back-filling a past day: the scheduled time on that date (noon if none). */
function stampFor(date: string, slot: string | null) {
  const d = keyToDate(date);
  const [h, m] = slot && slot !== '--:--' ? slot.split(':').map(Number) : [12, 0];
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
export const suppTake = defineCommand({ name: 'supplements.log', kind: 'action',
  description: 'Log a supplement as taken or skipped, or correct an existing log. date+time identify the scheduled dose; time null/omitted = as-needed (each call adds a new log). ' +
    'If a log already exists for that date+time (or logId is given) it is updated instead of duplicated. amount defaults to the existing log\'s amount, else the dose in force that day. ' +
    'takenAt defaults to now for today, or to the scheduled time (noon if none) when back-filling a past day; an existing log keeps its time unless takenAt is given. ' +
    'For injections (subq/im) site defaults to the existing log\'s site, else the least recently used site (rotation). Stock goes down by the amount taken and is corrected when a log changes. Returns the log.',
  input: z.object({ supplementId: zId, date: zDate.optional(), time: zTime.nullable().optional().describe('scheduled slot HH:MM; null/omitted for as-needed'),
    status: z.enum(['taken', 'skipped']).default('taken'), amount: z.number().positive().optional(), site: z.string().min(1).optional().describe('injection site, e.g. "Abdomen L"'),
    takenAt: z.string().datetime({ offset: true }).optional(), logId: zId.optional().describe('edit this specific log (logId from supplements.day / supplements.history)') }),
  run: async ({ supplementId, date, time, status, amount, site, takenAt, logId }) => {
    const s = await db.supplements.get(supplementId); if (!s || !alive(s)) throw new Error('Supplement not found');
    let existing: SuppLog | undefined;
    if (logId) { existing = await db.supplogs.get(logId); if (!existing || !alive(existing) || existing.supplementId !== supplementId) throw new Error('Log not found'); }
    const d = date ?? existing?.date ?? dateKey();
    const slot = time === undefined && existing ? existing.slot : time ?? null;
    if (!existing && slot) existing = await db.supplogs.where('[supplementId+date]').equals([supplementId, d]).filter((l) => alive(l) && l.slot === slot).first();
    const inj = s.route === 'subq' || s.route === 'im';
    const amt = amount ?? existing?.amount ?? doseOn(s, d);
    const at = takenAt ? Date.parse(takenAt) : existing ? undefined : d === dateKey() ? Date.now() : stampFor(d, slot);
    const rec = await logTake(s, d, slot, amt, { status, takenAt: at, site: inj ? site ?? existing?.site ?? await nextSite(s.id) : null, existing });
    // logTake only adjusts stock for new takes; correct it when an existing log changes status/amount
    if (existing && s.stock != null) {
      const delta = (existing.status === 'taken' ? existing.amount : 0) - (status === 'taken' ? amt : 0);
      if (delta) await save('supplements', { ...s, stock: Math.max(0, s.stock + delta) });
    }
    return rec;
  } });
export const suppUnlog = defineCommand({ name: 'supplements.unlog', kind: 'action', description: 'Remove a supplement log entry (undo a take/skip). Stock is given back if it was a take.',
  input: z.object({ logId: zId }), run: async ({ logId }) => { const l = await db.supplogs.get(logId); if (!l || !alive(l)) throw new Error('Log not found');
    await undoTake(l, await db.supplements.get(l.supplementId)); return { ok: true }; } });
export const suppHistory = defineCommand({ name: 'supplements.history', kind: 'query', description: 'Every log of one supplement (or all) between dates: date, time, dose, status, site. Use to find when something was started/stopped and adherence.',
  input: z.object({ supplementId: zId.optional(), from: zDate.optional(), to: zDate.optional() }),
  run: async ({ supplementId, from, to }) => (await db.supplogs.where('date').between(from ?? '0000-00-00', to ?? '9999-12-31', true, true)
    .filter((l) => alive(l) && (!supplementId || l.supplementId === supplementId)).sortBy('date'))
    .map((l) => ({ id: l.id, supplementId: l.supplementId, date: l.date, slot: l.slot, status: l.status, amount: l.amount, unit: l.unit, site: l.site, takenAt: l.takenAt ? new Date(l.takenAt).toISOString() : null })) });

export const suppPeriods = defineCommand({ name: 'supplements.periods', kind: 'query',
  description: 'When a supplement was being taken, as compact on-periods {from, to} (taken days merged; gaps longer than gapDays end a period). Use for charts (on/off bands, e.g. creatine) and "since when have I been taking X". Omit supplementId for all supplements.',
  input: z.object({ supplementId: zId.optional(), from: zDate.optional(), to: zDate.optional(), gapDays: z.number().int().min(1).max(60).default(3) }),
  run: async ({ supplementId, from, to, gapDays }) => {
    const logs = await db.supplogs.where('date').between(from ?? '0000-00-00', to ?? '9999-12-31', true, true)
      .filter((l) => alive(l) && l.status === 'taken' && (!supplementId || l.supplementId === supplementId)).toArray();
    const sups = new Map((await db.supplements.toArray()).map((s) => [s.id, s.name]));
    const byId = new Map<string, string[]>();
    for (const l of logs) byId.set(l.supplementId, [...(byId.get(l.supplementId) ?? []), l.date]);
    const day = (k: string) => keyToDate(k).getTime() / 86400000;
    return [...byId].map(([id, ds]) => {
      const dates = [...new Set(ds)].sort();
      const periods: { from: string; to: string; days: number }[] = [];
      for (const d of dates) {
        const cur = periods[periods.length - 1];
        if (cur && day(d) - day(cur.to) <= gapDays) { cur.to = d; cur.days++; } else periods.push({ from: d, to: d, days: 1 });
      }
      return { supplementId: id, name: sups.get(id) ?? null, periods };
    });
  } });

// ---------------- notes ----------------
export const notesAdd = defineCommand({ name: 'notes.add', kind: 'action', description: 'Add a journal note (side effects, how you feel). tags: supplement ids and/or "side-effect". Returns the note.',
  input: z.object({ text: z.string().trim().min(1), tags: z.array(z.string()).default([]), at: z.string().datetime({ offset: true }).optional() }),
  run: async ({ text, tags, at }) => save('notes', newRecord({ text, tags: [...new Set(tags)], at: at ? Date.parse(at) : Date.now() }) as Note) });
export const notesList = defineCommand({ name: 'notes.list', kind: 'query', description: 'Journal notes between dates, newest first.',
  input: z.object({ from: zDate.optional(), to: zDate.optional() }),
  run: async ({ from, to }) => (await db.notes.where('at').between(from ? keyToDate(from).getTime() : 0, to ? keyToDate(to).getTime() + 86400000 : Date.now() + 86400000).filter(alive).reverse().sortBy('at'))
    .map((n) => ({ id: n.id, at: new Date(n.at).toISOString(), text: n.text, tags: n.tags })) });
export const notesDelete = defineCommand({ name: 'notes.delete', kind: 'action', description: 'Delete a journal note.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('notes', id); return { ok: true }; } });

// ---------------- settings ----------------
export const settingsGet = defineCommand({ name: 'settings.get', kind: 'query', description: 'App settings: units, effort mode, active plan, feature switches, default rests, weigh-in interval.',
  input: z.object({}), run: async () => getSettings() });
const zFeatures = z.object({ gym: z.boolean(), food: z.boolean(), supplements: z.boolean(), survey: z.boolean(),
  restTimer: z.boolean(), effort: z.boolean(), warmups: z.boolean(), progression: z.boolean(), planWeek: z.boolean(), adaptiveMaintenance: z.boolean(), agent: z.boolean(), journal: z.boolean(), score: z.boolean() }).partial();
export const settingsUpdate = defineCommand({ name: 'settings.update', kind: 'action',
  description: 'Change settings; only the fields you pass change. unit kg/lb (display unit, data stays in kg), effortMode rir/rpe, activePlanId (a plan id, or null to clear the active plan), ' +
    'restCompoundSec / restIsolationSec (default rests, 15-600 s), weighInEveryDays (reminder interval), features: switch app sections on/off (merged into the current switches; gym, food, supplements, restTimer, effort = RIR/RPE column, warmups, survey = post-workout survey on the workout summary, progression = progression targets in the live workout instead of the last-session numbers, planWeek = "Week N" next to the active plan, adaptiveMaintenance = maintenance estimated from food logs + weight trend instead of the formula only, agent = the in-app AI assistant, journal = the life-event journal, score = the e1RM score column in the live set table). Returns all settings.',
  input: z.object({ unit: z.enum(['kg', 'lb']).optional(), effortMode: z.enum(['rir', 'rpe']).optional(), activePlanId: zId.nullable().optional(),
    restCompoundSec: z.number().int().min(15).max(600).optional(), restIsolationSec: z.number().int().min(15).max(600).optional(),
    weighInEveryDays: z.number().int().min(1).max(30).optional(), features: zFeatures.optional() }),
  run: async ({ features, activePlanId, ...p }) => {
    const s = await getSettings();
    const patch: Partial<Settings> = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    if (activePlanId !== undefined) {
      if (activePlanId && !alive(await db.plans.get(activePlanId))) throw new Error('Plan not found');
      patch.activePlanId = activePlanId ?? undefined;
    }
    if (features) patch.features = { ...s.features, ...Object.fromEntries(Object.entries(features).filter(([, v]) => v !== undefined)) };
    await updateSettings(patch);
    return getSettings();
  } });

// ---------------- data (backup) ----------------
export const dataExport = defineCommand({ name: 'data.export', kind: 'query',
  description: `Full backup of all data as one JSON object { app: "tap-in", version, exportedAt, data: { <table>: rows[] } } covering ${BACKUP_TABLES.join(', ')} (custom/edited exercises only). Feed it to data.import to restore.`,
  input: z.object({}), run: async () => buildBackup() });
export const dataImport = defineCommand({ name: 'data.import', kind: 'action',
  description: 'Restore a backup made by data.export. Every record in it replaces the record with the same id here (nothing else is deleted). Imported records are stamped as just changed and queued for sync, so they win over older copies on the server and other devices. Returns { imported: number of records }.',
  input: z.object({ app: z.string().describe('must be "tap-in"'), version: z.number().optional(), exportedAt: z.string().optional(),
    data: z.record(z.string(), z.array(z.looseObject({ id: z.string().min(1) }))) }),
  run: async (backup) => {
    if (backup.app !== 'tap-in') throw new Error('Not a Tap In backup');
    return { imported: await restoreBackup(backup.data) };
  } });
