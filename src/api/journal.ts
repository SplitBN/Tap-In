// Journal: dated life events that can't be inferred from the logs ("Started cut", "Exam season", "Moved out", "Sick").
// Shown on its own page, on the Calendar and as overlays on the assistant's charts.
import { z } from 'zod';
import { defineCommand, zDate, zId } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import type { JournalEntry } from '../db/types';
import { dateKey, keyToDate, shiftDate } from '../lib/nutrition';
import { suppPeriods } from './body';

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

// ---------------- timeline (chart event stamps) ----------------
const TAG_ICON: Record<string, string> = { diet: 'food', training: 'dumbbell', health: 'fire', life: 'flag', other: 'flag' };
export const timelineEvents = defineCommand({ name: 'timeline.events', kind: 'query',
  description: 'Dated events to annotate progress charts with, oldest first: journal entries (kind "journal": "Started cut", "Sick"…) and supplement on-periods (kind "supplement": when something was being taken, from supplements.periods; logs up to 8 days apart count as one period, so weekly doses form one; deleted supplements and periods spanning fewer than minDays are left out). ' +
    'Each: id, kind, label, from (YYYY-MM-DD), to (YYYY-MM-DD, or null = still ongoing; equal to from for a single day), tag (journal) and icon (a UI icon name). Overlapping from..to only.',
  input: z.object({ from: zDate.optional(), to: zDate.optional(), minDays: z.number().int().min(1).max(60).default(3), supplements: z.boolean().default(true) }),
  run: async ({ from, to, minDays, supplements }) => {
    const today = dateKey();
    const out: { id: string; kind: 'journal' | 'supplement'; label: string; from: string; to: string | null; tag?: string; icon: string }[] = [];
    for (const j of await journalList.run({ from, to })) out.push({ id: j.id, kind: 'journal', label: j.title, from: j.date, to: j.ongoing ? null : j.endDate ?? j.date, ...(j.tag ? { tag: j.tag } : {}), icon: TAG_ICON[j.tag ?? 'other'] ?? 'flag' });
    if (supplements) {
      const live = new Map((await db.supplements.filter(alive).toArray()).map((s) => [s.id, s]));
      for (const s of await suppPeriods.run({ from, to, gapDays: 8 })) {
        const sup = live.get(s.supplementId); if (!sup) continue;
        const icon = sup.route === 'subq' || sup.route === 'im' ? 'syringe' : 'pill';
        const last = s.periods[s.periods.length - 1];
        for (const p of s.periods) {
          const span = Math.round((keyToDate(p.to).getTime() - keyToDate(p.from).getTime()) / 864e5) + 1;
          if (span < minDays) continue;
          // the latest period of a supplement still being taken (logged in the last 8 days, not archived) is ongoing
          const ongoing = p === last && !sup.archived && p.to >= shiftDate(today, -8);
          out.push({ id: `${s.supplementId}:${p.from}`, kind: 'supplement', label: sup.name, from: p.from, to: ongoing ? null : p.to, icon });
        }
      }
    }
    return out.sort((a, b) => a.from.localeCompare(b.from));
  } });
