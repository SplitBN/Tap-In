// Journal: dated life events that can't be inferred from the logs ("Started cut", "Exam season", "Moved out", "Sick").
// Shown on its own page, on the Calendar and as overlays on the assistant's charts.
import { z } from 'zod';
import { defineCommand, zDate, zId } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import type { JournalEntry } from '../db/types';
import { dateKey } from '../lib/nutrition';

const zTag = z.enum(['diet', 'training', 'health', 'life', 'other']);
export const journalView = (j: JournalEntry) => ({ id: j.id, date: j.date, ...(j.endDate ? { endDate: j.endDate } : {}), ongoing: j.endDate === null, title: j.title, note: j.note, tag: j.tag });
const need = async (id: string) => { const j = await db.journal.get(id); if (!j || !alive(j)) throw new Error(`No journal entry with id "${id}"`); return j; };

export const journalList = defineCommand({ name: 'journal.list', kind: 'query',
  description: 'Journal entries (life events like "Started cut", "Exam season", "Sick") that overlap from..to, oldest first. Each: date, endDate (a range), ongoing (no end yet) or neither (a single day), title, note, tag.',
  input: z.object({ from: zDate.optional(), to: zDate.optional() }),
  run: async ({ from, to }) => (await db.journal.orderBy('date').filter(alive).toArray())
    .filter((j) => (!to || j.date <= to) && (!from || j.endDate === null || (j.endDate ?? j.date) >= from)).map(journalView) });

export const journalAdd = defineCommand({ name: 'journal.add', kind: 'action',
  description: 'Add a journal entry: a dated life event the logs cannot show. date defaults to today; ongoing=true for something that lasts until ended (a cut, exam season); endDate for a known range; neither = a single day. tag: diet | training | health | life | other. Returns the entry.',
  input: z.object({ title: z.string().trim().min(1).max(80), date: zDate.optional(), endDate: zDate.optional(), ongoing: z.boolean().optional(), note: z.string().trim().max(500).optional(), tag: zTag.optional() }),
  run: async ({ title, date, endDate, ongoing, note, tag }) => {
    const d = date ?? dateKey();
    if (endDate && endDate < d) throw new Error('endDate is before date');
    return journalView(await save('journal', newRecord({ title, date: d, ...(endDate ? { endDate } : ongoing ? { endDate: null } : {}), ...(note ? { note } : {}), ...(tag ? { tag } : {}) }) as JournalEntry));
  } });

export const journalUpdate = defineCommand({ name: 'journal.update', kind: 'action',
  description: 'Edit a journal entry; only the fields you pass change. endDate null = ongoing again; singleDay true = a single day (no end); note "" clears it.',
  input: z.object({ id: zId, title: z.string().trim().min(1).max(80).optional(), date: zDate.optional(), endDate: zDate.nullable().optional(), singleDay: z.boolean().optional(), note: z.string().trim().max(500).optional(), tag: zTag.optional() }),
  run: async ({ id, note, singleDay, ...p }) => {
    const j = await need(id);
    const next: JournalEntry = { ...j, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)), ...(note !== undefined ? { note: note || undefined } : {}) };
    if (singleDay) delete next.endDate;
    if (next.endDate && next.endDate < next.date) throw new Error('endDate is before date');
    return journalView(await save('journal', next));
  } });

export const journalEnd = defineCommand({ name: 'journal.end', kind: 'action',
  description: 'End an ongoing journal entry ("stopped the cut"): sets its endDate (default today). Returns the entry.',
  input: z.object({ id: zId, endDate: zDate.optional() }),
  run: async ({ id, endDate }) => {
    const j = await need(id);
    const e = endDate ?? dateKey();
    if (e < j.date) throw new Error('endDate is before the start');
    return journalView(await save('journal', { ...j, endDate: e }));
  } });

export const journalDelete = defineCommand({ name: 'journal.delete', kind: 'action', description: 'Delete a journal entry.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('journal', id); return { ok: true }; } });
