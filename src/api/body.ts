import { z } from 'zod';
import { defineCommand, zDate, zId, zTime } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import { buildDay, doseOn, logTake, nextSite, scheduleText, undoTake } from '../db/supps';
import { getSettings, updateSettings } from '../db/settings';
import type { Note, Stack, Supplement } from '../db/types';
import { dateKey, keyToDate } from '../lib/nutrition';

// ---------------- bodyweight ----------------
export const weightLog = defineCommand({ name: 'bodyweight.log', kind: 'action', description: 'Log a weigh-in in kg (at = ISO time, defaults to now).',
  input: z.object({ kg: z.number().min(20).max(400), at: z.string().datetime({ offset: true }).optional(), note: z.string().optional() }),
  run: async ({ kg, at, note }) => save('bodyweight', newRecord({ kg, at: at ? Date.parse(at) : Date.now(), note })) });
export const weightUpdate = defineCommand({ name: 'bodyweight.update', kind: 'action', description: 'Correct a weigh-in.',
  input: z.object({ id: zId, kg: z.number().min(20).max(400).optional(), at: z.string().datetime({ offset: true }).optional() }),
  run: async ({ id, kg, at }) => { const e = await db.bodyweight.get(id); if (!e || !alive(e)) throw new Error('Weigh-in not found'); return save('bodyweight', { ...e, kg: kg ?? e.kg, at: at ? Date.parse(at) : e.at }); } });
export const weightDelete = defineCommand({ name: 'bodyweight.delete', kind: 'action', description: 'Delete a weigh-in.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('bodyweight', id); return { ok: true }; } });
export const weightList = defineCommand({ name: 'bodyweight.list', kind: 'query', description: 'Weigh-ins between dates (inclusive), oldest first.',
  input: z.object({ from: zDate.optional(), to: zDate.optional() }),
  run: async ({ from, to }) => (await db.bodyweight.where('at').between(from ? keyToDate(from).getTime() : 0, to ? keyToDate(to).getTime() + 86400000 : Date.now() + 86400000).filter(alive).sortBy('at'))
    .map((e) => ({ id: e.id, date: dateKey(e.at), at: new Date(e.at).toISOString(), kg: e.kg, note: e.note })) });

// ---------------- supplements ----------------
const zSchedule = z.object({
  kind: z.enum(['daily', 'weekdays', 'interval', 'weekly', 'asNeeded']),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('weekdays 0=Sun..6=Sat, for kind "weekdays"'),
  every: z.number().int().min(2).optional().describe('every N days, for kind "interval"'),
  times: z.array(zTime).default([]).describe('times of day it is due; empty for asNeeded'),
  startDate: zDate.optional().describe('first day (default today). kind "weekly" repeats on the weekday of this date; "interval" counts from it; cycles start here'),
  cycle: z.object({ onDays: z.number().int().min(1), offDays: z.number().int().min(0) }).nullable().optional(),
});
const suppView = (s: Supplement) => ({ id: s.id, name: s.name, form: s.form, route: s.route, unit: s.unit, currentDose: doseOn(s, dateKey()), doseHistory: s.doses,
  schedule: s.schedule, scheduleText: scheduleText(s.schedule), stock: s.stock ?? null, notes: s.notes, archived: !!s.archived });

export const suppList = defineCommand({ name: 'supplements.list', kind: 'query', description: 'All supplements/medications/peptides with dose history, schedule and stock, plus stacks.',
  input: z.object({}), run: async () => ({
    supplements: (await db.supplements.filter(alive).toArray()).map(suppView),
    stacks: (await db.stacks.filter(alive).toArray()).map((s) => ({ id: s.id, name: s.name, supplementIds: s.supplementIds })),
  }) });
export const suppSave = defineCommand({ name: 'supplements.save', kind: 'action',
  description: 'Create (no id) or update a supplement. dose sets the dose from startDate/today when creating; to change the dose of an existing one use supplements.changeDose (keeps titration history). form "injection" implies subcutaneous route.',
  input: z.object({ id: zId.optional(), name: z.string().min(1).optional(), form: z.enum(['capsule', 'tablet', 'powder', 'liquid', 'injection', 'other']).optional(),
    route: z.enum(['oral', 'subq', 'im', 'other']).optional(), unit: z.string().optional(), dose: z.number().positive().optional(),
    schedule: zSchedule.optional(), stock: z.number().min(0).nullable().optional(), notes: z.string().optional(), archived: z.boolean().optional() }),
  run: async ({ id, dose, schedule, ...p }) => {
    const today = dateKey();
    if (id) {
      const s = await db.supplements.get(id); if (!s || !alive(s)) throw new Error('Supplement not found');
      return suppView(await save('supplements', { ...s, ...p, schedule: schedule ? { ...s.schedule, ...schedule, startDate: schedule.startDate ?? s.schedule.startDate } : s.schedule } as Supplement));
    }
    if (!p.name || dose == null) throw new Error('name and dose are required to create');
    const form = p.form ?? 'capsule';
    const sched = { kind: 'daily' as const, times: ['08:00'], ...schedule, startDate: schedule?.startDate ?? today };
    return suppView(await save('supplements', newRecord({ name: p.name, form, route: p.route ?? (form === 'injection' ? 'subq' : 'oral'), unit: p.unit ?? 'mg',
      doses: [{ from: sched.startDate <= today ? sched.startDate : today, amount: dose }], schedule: sched, stock: p.stock ?? null, notes: p.notes, archived: false }) as Supplement));
  } });
export const suppDose = defineCommand({ name: 'supplements.changeDose', kind: 'action', description: 'Change a dose from a date on (titration); earlier dose steps stay in history. If a step already starts on that exact date it is replaced (a correction).',
  input: z.object({ id: zId, amount: z.number().positive(), from: zDate.optional() }),
  run: async ({ id, amount, from }) => { const s = await db.supplements.get(id); if (!s || !alive(s)) throw new Error('Supplement not found');
    const d = from ?? dateKey(); return suppView(await save('supplements', { ...s, doses: [...s.doses.filter((x) => x.from !== d), { from: d, amount }] })); } });
export const suppDelete = defineCommand({ name: 'supplements.delete', kind: 'action', description: 'Delete a supplement (its logs stay for analysis). Prefer archived=true via supplements.save to "stop taking".',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('supplements', id); return { ok: true }; } });
export const stackSave = defineCommand({ name: 'stacks.save', kind: 'action', description: 'Create/update a stack: supplements taken together and checked off in one go.',
  input: z.object({ id: zId.optional(), name: z.string().min(1), supplementIds: z.array(zId).min(2) }),
  run: async ({ id, ...p }) => { const s = id ? await db.stacks.get(id) : undefined; return save('stacks', s ? { ...s, ...p } : newRecord(p) as Stack); } });
export const stackDelete = defineCommand({ name: 'stacks.delete', kind: 'action', description: 'Delete a stack.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('stacks', id); return { ok: true }; } });

export const suppDay = defineCommand({ name: 'supplements.day', kind: 'query', description: 'The checklist for a date: what was due at which time, the dose, and whether it was taken/skipped (with time and injection site).',
  input: z.object({ date: zDate.optional() }),
  run: async ({ date }) => {
    const d = date ?? dateKey();
    const [sups, stacks, logs] = await Promise.all([db.supplements.filter(alive).toArray(), db.stacks.filter(alive).toArray(), db.supplogs.where('date').equals(d).filter(alive).toArray()]);
    return buildDay(d, sups, stacks, logs).map((g) => ({ time: g.slot, groups: g.stacks.map((st) => ({ stack: st.stack?.name ?? null,
      items: st.items.map((i) => ({ supplementId: i.sup.id, name: i.sup.name, dose: i.amount, unit: i.sup.unit, status: i.log?.status ?? 'due', takenAt: i.log?.takenAt ? new Date(i.log.takenAt).toISOString() : null, site: i.log?.site ?? null, logId: i.log?.id })) })) }));
  } });
export const suppTake = defineCommand({ name: 'supplements.log', kind: 'action',
  description: 'Log a supplement as taken or skipped. date+time identify the scheduled dose (omit time for as-needed). amount defaults to the scheduled dose; injection site defaults to the least recently used.',
  input: z.object({ supplementId: zId, date: zDate.optional(), time: zTime.optional(), status: z.enum(['taken', 'skipped']).default('taken'),
    amount: z.number().positive().optional(), site: z.string().optional(), takenAt: z.string().datetime({ offset: true }).optional() }),
  run: async ({ supplementId, date, time, status, amount, site, takenAt }) => {
    const s = await db.supplements.get(supplementId); if (!s || !alive(s)) throw new Error('Supplement not found');
    const d = date ?? dateKey();
    const existing = await db.supplogs.where('[supplementId+date]').equals([supplementId, d]).filter((l) => alive(l) && l.slot === (time ?? null)).first();
    const inj = s.route === 'subq' || s.route === 'im';
    return logTake(s, d, time ?? null, amount ?? doseOn(s, d), { status, takenAt: takenAt ? Date.parse(takenAt) : undefined,
      site: inj ? site ?? existing?.site ?? await nextSite(s.id) : null, existing: time ? existing : undefined });
  } });
export const suppUnlog = defineCommand({ name: 'supplements.unlog', kind: 'action', description: 'Remove a supplement log entry (undo a take/skip).',
  input: z.object({ logId: zId }), run: async ({ logId }) => { const l = await db.supplogs.get(logId); if (!l) throw new Error('Log not found');
    await undoTake(l, await db.supplements.get(l.supplementId)); return { ok: true }; } });
export const suppHistory = defineCommand({ name: 'supplements.history', kind: 'query', description: 'Every log of one supplement (or all) between dates: date, time, dose, status, site. Use to find when something was started/stopped and adherence.',
  input: z.object({ supplementId: zId.optional(), from: zDate.optional(), to: zDate.optional() }),
  run: async ({ supplementId, from, to }) => (await db.supplogs.where('date').between(from ?? '0000-00-00', to ?? '9999-12-31', true, true)
    .filter((l) => alive(l) && (!supplementId || l.supplementId === supplementId)).sortBy('date'))
    .map((l) => ({ id: l.id, supplementId: l.supplementId, date: l.date, slot: l.slot, status: l.status, amount: l.amount, unit: l.unit, site: l.site, takenAt: l.takenAt ? new Date(l.takenAt).toISOString() : null })) });

// ---------------- notes ----------------
export const notesAdd = defineCommand({ name: 'notes.add', kind: 'action', description: 'Add a journal note (side effects, how you feel). tags: supplement ids and/or "side-effect".',
  input: z.object({ text: z.string().min(1), tags: z.array(z.string()).default([]), at: z.string().datetime({ offset: true }).optional() }),
  run: async ({ text, tags, at }) => save('notes', newRecord({ text, tags, at: at ? Date.parse(at) : Date.now() }) as Note) });
export const notesList = defineCommand({ name: 'notes.list', kind: 'query', description: 'Journal notes between dates, newest first.',
  input: z.object({ from: zDate.optional(), to: zDate.optional() }),
  run: async ({ from, to }) => (await db.notes.where('at').between(from ? keyToDate(from).getTime() : 0, to ? keyToDate(to).getTime() + 86400000 : Date.now() + 86400000).filter(alive).reverse().sortBy('at'))
    .map((n) => ({ id: n.id, at: new Date(n.at).toISOString(), text: n.text, tags: n.tags })) });
export const notesDelete = defineCommand({ name: 'notes.delete', kind: 'action', description: 'Delete a journal note.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('notes', id); return { ok: true }; } });

// ---------------- settings ----------------
export const settingsGet = defineCommand({ name: 'settings.get', kind: 'query', description: 'App settings: units, effort mode, feature switches, default rests, weigh-in interval.',
  input: z.object({}), run: async () => getSettings() });
export const settingsUpdate = defineCommand({ name: 'settings.update', kind: 'action', description: 'Change settings (unit kg/lb, effortMode rir/rpe, restCompoundSec, restIsolationSec, weighInEveryDays, features on/off).',
  input: z.object({ unit: z.enum(['kg', 'lb']).optional(), effortMode: z.enum(['rir', 'rpe']).optional(), restCompoundSec: z.number().int().min(15).max(600).optional(),
    restIsolationSec: z.number().int().min(15).max(600).optional(), weighInEveryDays: z.number().int().min(1).max(30).optional(),
    features: z.record(z.string(), z.boolean()).optional() }),
  run: async ({ features, ...p }) => { const s = await getSettings(); await updateSettings({ ...p, ...(features ? { features: { ...s.features, ...features } } : {}) }); return getSettings(); } });
