// Import from other apps (Settings → Import): Alpha Progression CSV exports (workouts, plans, custom exercises,
// bodyweight) and MyNetDiary yearly .xls exports (food log, body weight).
//   import.preview  what would be imported: counts, date ranges, the exercise mapping with confidence, warnings
//   import.run      writes it (mapping overrides applied); every record carries importId and a stable id, so a re-run
//                   never duplicates and import.undo removes one run as a whole (normal soft deletes, so it syncs)
//   import.list     past runs with what is still in the app
// Imported records are history: sessions are finished (endedAt), sets have rir null (Alpha has no RIR) and no live-workout
// flow runs for them (no rest timers, rewards or survey; the summary hides the survey for imported sessions), food days
// never get the morning "was that everything?" card. The agent may list and undo (always behind a request card — "import"
// is in no auto-apply category), never preview/run: those take the raw file bytes (lib/agent/tools.ts blocks them).
import { z } from 'zod';
import { defineCommand } from './registry';
import { alive, db, saveMany, type SyncedTable } from '../db/db';
import { getSettings, updateSettings } from '../db/settings';
import type { Base, BodyweightEntry, Exercise, FoodEntry, LoadType, Plan, Session, SetLog, Workout, WorkoutItem } from '../db/types';
import { normalizeSupersets } from '../components/ItemSettings';
import {
  detectKind, mndFood, mndWeights, parseAlphaCustom, parseAlphaMeasurements, parseAlphaPlans, parseAlphaWorkouts, planBaseName, stableHash,
  type AlphaCustom, type AlphaPlan, type AlphaWorkout, type ImportKind, type MndFood, type WeighIn,
} from '../lib/importParse';
import { asCustomTarget, collectRefs, mapExercises, type MapRow, type MapTarget } from '../lib/importMap';

// ---------------- input ----------------
const zFile = z.object({
  name: z.string().describe('File name, e.g. "2026_11_25 Workouts.csv"'),
  text: z.string().optional().describe('Contents of a text (CSV) file'),
  base64: z.string().optional().describe('Contents of a binary file (.xls/.xlsx), base64'),
}).refine((f) => f.text != null || f.base64 != null, 'Give text or base64');
const zOverride = z.union([
  z.object({ kind: z.literal('existing'), id: z.string().min(1).describe('Tap In exercise id to use') }),
  z.object({ kind: z.literal('create').describe('Create it as a custom exercise') }),
]);
const zInput = z.object({
  files: z.array(zFile).min(1).max(20),
  overrides: z.record(z.string(), zOverride).optional().describe('Exercise mapping fixes by mapping key ("<Alpha name>|<Alpha equipment>")'),
});
type Input = z.output<typeof zInput>;
type Override = z.output<typeof zOverride>;

// ---------------- progress (UI subscribes; commands stay plain input → output) ----------------
export interface ImportProgress { phase: string; done: number; total: number }
const progressSubs = new Set<(p: ImportProgress | null) => void>();
export const onImportProgress = (fn: (p: ImportProgress | null) => void) => { progressSubs.add(fn); return () => { progressSubs.delete(fn); }; };
const progress = (p: ImportProgress | null) => progressSubs.forEach((f) => f(p));

// ---------------- parsing (cached per file contents: preview, overrides and run reuse it) ----------------
interface Parsed {
  files: { name: string; kind: ImportKind; rows: number }[];
  workouts: AlphaWorkout[]; plans: AlphaPlan[]; custom: AlphaCustom[]; weighIns: WeighIn[]; food: MndFood[];
}
const cache = new Map<string, { kind: ImportKind; rows: number; part: Partial<Parsed> }>();
const b64ToBytes = (b64: string) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

async function parseFile(f: z.output<typeof zFile>) {
  const body = f.text ?? f.base64!;
  const key = `${f.name}|${body.length}|${stableHash(body)}`;
  const hit = cache.get(key);
  if (hit) return { key, ...hit };
  let out: { kind: ImportKind; rows: number; part: Partial<Parsed> };
  if (f.base64 != null) {
    const bytes = b64ToBytes(f.base64);
    const kind = detectKind(f.name, bytes.subarray(0, 8));
    if (kind !== 'mnd') out = { kind: 'unknown', rows: 0, part: {} };
    else {
      const XLSX = await import('xlsx'); // lazy: SheetJS only loads when an .xls is imported
      const wb = XLSX.read(bytes, { type: 'array' });
      const sheet = (n: string) => { const ws = wb.Sheets[wb.SheetNames.find((s) => s.toLowerCase() === n) ?? '']; return ws ? XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, raw: true, defval: null }) : []; };
      const food = mndFood(sheet('food')), weighIns = mndWeights(sheet('measurements'));
      out = { kind: food.length || weighIns.length ? 'mnd' : 'unknown', rows: food.length + weighIns.length, part: { food, weighIns } };
    }
  } else {
    const text = f.text!;
    const kind = detectKind(f.name, text);
    const part: Partial<Parsed> =
      kind === 'alpha-workouts' ? { workouts: parseAlphaWorkouts(text) } : kind === 'alpha-plans' ? { plans: parseAlphaPlans(text) }
        : kind === 'alpha-custom' ? { custom: parseAlphaCustom(text) } : kind === 'alpha-measurements' ? { weighIns: parseAlphaMeasurements(text) } : {};
    const rows = (part.workouts?.length ?? 0) + (part.plans?.length ?? 0) + (part.custom?.length ?? 0) + (part.weighIns?.length ?? 0);
    out = { kind, rows, part };
  }
  cache.set(key, out);
  return { key, ...out };
}

async function parseAll(files: Input['files']): Promise<Parsed> {
  const p: Parsed = { files: [], workouts: [], plans: [], custom: [], weighIns: [], food: [] };
  const seen = new Set<string>();
  for (const f of files) {
    const r = await parseFile(f);
    p.files.push({ name: f.name, kind: r.kind, rows: r.rows });
    if (seen.has(r.key.slice(r.key.indexOf('|')))) continue; // the same file picked twice
    seen.add(r.key.slice(r.key.indexOf('|')));
    p.workouts.push(...(r.part.workouts ?? [])); p.plans.push(...(r.part.plans ?? [])); p.custom.push(...(r.part.custom ?? []));
    p.weighIns.push(...(r.part.weighIns ?? [])); p.food.push(...(r.part.food ?? []));
  }
  return p;
}

// ---------------- building records ----------------
const localMs = (date: string, time = '12:00') => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const MEAL_TIME: Record<string, string> = { breakfast: '08:00', lunch: '13:00', snacks: '16:00', dinner: '19:30' };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const range = (xs: string[]) => (xs.length ? { from: xs.reduce((a, b) => (a < b ? a : b)), to: xs.reduce((a, b) => (a > b ? a : b)) } : null);
const SNAP_DAYS = 30;

type Status = 'new' | 'existing' | 'revive';
interface Built {
  parsed: Parsed; mapping: (MapRow & { overridden?: boolean })[];
  exercises: Exercise[]; plans: Plan[]; workouts: Workout[]; sessions: Session[]; sets: SetLog[]; weights: BodyweightEntry[]; entries: FoodEntry[];
  duplicateWeights: number; skippedEmpty: number; warnings: string[];
}

async function build(input: Input): Promise<Built> {
  const parsed = await parseAll(input.files);
  const pool = (await db.exercises.toArray()).filter(alive);
  const poolById = new Map(pool.map((e) => [e.id, e]));
  const refs = collectRefs(parsed.workouts, parsed.plans);
  const mapping: Built['mapping'] = mapExercises(refs, pool, parsed.custom);
  for (const row of mapping) {
    const o: Override | undefined = input.overrides?.[row.key];
    if (!o) continue;
    if (o.kind === 'existing') {
      const e = poolById.get(o.id);
      if (!e) throw new Error(`Exercise ${o.id} not found (override for "${row.name} · ${row.equipment}")`);
      Object.assign(row, { target: { kind: 'existing', id: e.id } as MapTarget, targetName: e.name, overridden: true, why: 'Your choice' });
    } else {
      const ref = refs.find((r) => `${r.name}|${r.equipment}` === row.key)!;
      const t = asCustomTarget(ref, parsed.custom);
      Object.assign(row, { target: t, targetName: t.spec.name, overridden: true, why: 'Your choice: new custom exercise' });
    }
  }
  const byKey = new Map(mapping.map((r) => [r.key, r]));
  const exercises: Exercise[] = [];
  const loadTypeOf = new Map<string, LoadType>();
  for (const r of mapping) {
    if (r.target.kind === 'create') {
      if (!exercises.some((x) => x.id === r.target.id)) exercises.push({ ...r.target.spec, id: r.target.id, createdAt: Date.now(), updatedAt: 0, deletedAt: null } as Exercise);
      loadTypeOf.set(r.target.id, r.target.spec.loadType);
    } else loadTypeOf.set(r.target.id, poolById.get(r.target.id)?.loadType ?? 'weighted');
  }
  const target = (name: string, equipment: string) => byKey.get(`${name}|${equipment}`)!;
  const noteOf = (name: string, equipment: string) => target(name, equipment).note;

  // plans: newest first in Plans (sorted by start date); a name used by two plans gets its month
  const plans: Plan[] = [], workouts: Workout[] = [];
  const nameCount = new Map<string, number>();
  for (const p of parsed.plans) nameCount.set(planBaseName(p.name), (nameCount.get(planBaseName(p.name)) ?? 0) + 1);
  const planLinks: { base: string; startDate: string; id: string; days: Map<number, string> }[] = [];
  for (const p of parsed.plans) {
    const base = planBaseName(p.name);
    const pid = `ap:p:${stableHash(p.name, p.startDate)}`;
    const name = (nameCount.get(base) ?? 0) > 1 ? `${base} · ${new Date(localMs(p.startDate)).toLocaleDateString('en', { month: 'short', year: 'numeric' })}` : base;
    const days = new Map<number, string>();
    const ws: Workout[] = [...p.days].sort((a, b) => a.day - b.day).map((d) => {
      const wk = stableHash(pid, d.day);
      const wid = `ap:pw:${wk}`;
      days.set(d.day, wid);
      const items: WorkoutItem[] = d.items.filter((it) => it.sets > 0).map((it, i) => ({
        key: `ap:pk:${wk}:${i}`, exerciseId: target(it.name, it.equipment).target.id, sets: it.sets,
        ...(it.reps ? { repsMin: it.reps[0], repsMax: it.reps[1] } : {}), rest: { mode: 'timer' as const },
        ...(it.superset ? { supersetId: `ap:pss:${wk}:${it.superset}` } : {}), ...(it.drops ? { drops: it.drops } : {}),
        ...(noteOf(it.name, it.equipment) ? { notes: noteOf(it.name, it.equipment) } : {}),
      }));
      return { id: wid, planId: pid, name: d.name, items: normalizeSupersets(items), createdAt: localMs(p.startDate), updatedAt: 0, deletedAt: null };
    });
    workouts.push(...ws);
    plans.push({ id: pid, name, workoutIds: ws.map((w) => w.id), startDate: p.startDate, createdAt: localMs(p.startDate), updatedAt: 0, deletedAt: null });
    planLinks.push({ base, startDate: p.startDate, id: pid, days });
  }
  const linkFor = (w: AlphaWorkout) => {
    if (!w.plan) return null;
    const cands = planLinks.filter((l) => l.base === w.plan && l.startDate <= w.date).sort((a, b) => b.startDate.localeCompare(a.startDate));
    const l = cands[0] ?? planLinks.find((x) => x.base === w.plan);
    return l ? { planId: l.id, workoutId: w.day != null ? l.days.get(w.day) : undefined } : null;
  };

  // weigh-ins: both sources merged; same day within 0.3 kg = one weigh-in (the app's own entries win)
  const existingW = (await db.bodyweight.toArray()).filter(alive);
  const weights: BodyweightEntry[] = [];
  let duplicateWeights = 0;
  const kept = existingW.map((e) => ({ date: dateOf(e.at), kg: e.kg, id: e.id }));
  for (const wi of [...parsed.weighIns].sort((a, b) => (a.source === b.source ? 0 : a.source === 'alpha' ? -1 : 1))) {
    const id = `${wi.source === 'alpha' ? 'ap' : 'mnd'}:bw:${stableHash(wi.date, wi.time, wi.kg)}`;
    const dup = kept.find((k) => k.date === wi.date && Math.abs(k.kg - wi.kg) <= 0.3 && k.id !== id);
    if (dup) { duplicateWeights++; continue; }
    if (weights.some((w) => w.id === id)) continue;
    const at = localMs(wi.date, wi.time);
    weights.push({ id, at, kg: wi.kg, createdAt: at, updatedAt: 0, deletedAt: null });
    kept.push({ date: wi.date, kg: wi.kg, id });
  }
  const scale = [...existingW.filter((e) => !weights.some((w) => w.id === e.id)), ...weights].map((e) => ({ at: e.at, kg: e.kg })).sort((a, b) => a.at - b.at);
  const bwNear = (at: number): number | null => {
    let lo = 0, hi = scale.length - 1, best: { at: number; kg: number } | null = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (scale[mid].at < at) lo = mid + 1; else hi = mid - 1; }
    for (const i of [lo - 1, lo]) { const c = scale[i]; if (c && (!best || Math.abs(c.at - at) < Math.abs(best.at - at))) best = c; }
    return best && Math.abs(best.at - at) <= SNAP_DAYS * 86400000 ? best.kg : null;
  };

  // sessions + sets
  const sessions: Session[] = [], sets: SetLog[] = [];
  let skippedEmpty = 0;
  for (const w of parsed.workouts) {
    if (!w.exercises.length) { skippedEmpty++; continue; }
    const sk = stableHash(w.date, w.time, w.name, w.plan ?? '');
    const id = `ap:s:${sk}`;
    const start = localMs(w.date, w.time);
    const durMs = Math.max(1, w.durationMin || 1) * 60000;
    const link = linkFor(w);
    const total = w.exercises.reduce((a, x) => a + x.sets.length, 0);
    let k = 0;
    const items: WorkoutItem[] = w.exercises.map((x, i) => {
      const key = `ap:k:${sk}:${i}`;
      const t = target(x.name, x.equipment).target;
      const lt = loadTypeOf.get(t.id) ?? 'weighted';
      x.sets.forEach((s, j) => {
        const doneAt = start + Math.round(((++k) * durMs) / (total + 1));
        const loadKg = s.load ?? (lt === 'weighted' ? null : 0);
        sets.push({
          id: `ap:set:${sk}:${i}:${j}`, sessionId: id, itemKey: key, exerciseId: t.id, setNo: j + 1, kind: 'working', side: 'both',
          loadKg, loadType: lt, bodyweightKg: lt === 'weighted' ? null : bwNear(start), inputUnit: 'kg', reps: s.reps, rir: null, rpe: null,
          doneAt, createdAt: doneAt, updatedAt: 0, deletedAt: null,
        });
      });
      return {
        key, exerciseId: t.id, sets: x.sets.length, ...(x.reps ? { repsMin: x.reps[0], repsMax: x.reps[1] } : {}), rest: { mode: 'timer' as const },
        ...(x.superset ? { supersetId: `ap:ss:${sk}:${x.superset}` } : {}), ...(x.drops ? { drops: x.drops } : {}),
        ...(noteOf(x.name, x.equipment) ? { notes: noteOf(x.name, x.equipment) } : {}),
      };
    });
    sessions.push({
      id, name: w.name, startedAt: start, endedAt: start + durMs, items: normalizeSupersets(items),
      ...(link ? { planId: link.planId, ...(link.workoutId ? { workoutId: link.workoutId } : {}) } : {}),
      createdAt: start, updatedAt: 0, deletedAt: null,
    });
  }

  // food: one entry per MyNetDiary row, nutrition snapshot kept, amount text shown in the log
  const entries: FoodEntry[] = [];
  const occ = new Map<string, number>();
  for (const f of parsed.food) {
    const ok = [f.date, f.meal, f.name, f.amount, f.n.kcal].join('|');
    const n = occ.get(ok) ?? 0; occ.set(ok, n + 1);
    const at = localMs(f.date, f.time ?? MEAL_TIME[f.meal]);
    const quick = /^(macros|calories)$/i.test(f.name);
    entries.push({
      id: `mnd:f:${stableHash(ok, n)}`, date: f.date, at, meal: f.meal, source: 'quick', name: quick ? 'Quick add' : f.name, grams: null,
      ...(f.amount && !quick ? { amount: f.amount } : {}), n: f.n, createdAt: at, updatedAt: 0, deletedAt: null,
    });
  }

  return { parsed, mapping, exercises, plans, workouts, sessions, sets, weights, entries, duplicateWeights, skippedEmpty, warnings: warningsFor(parsed, mapping, sessions, sets, entries, weights) };
}
const dateOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function warningsFor(parsed: Parsed, mapping: MapRow[], sessions: Session[], sets: SetLog[], entries: FoodEntry[], weights: BodyweightEntry[]) {
  const out: string[] = [];
  const unknown = parsed.files.filter((f) => f.kind === 'unknown');
  if (unknown.length) out.push(`Not recognised, skipped: ${unknown.map((f) => f.name).join(', ')}`);
  const nameOf = new Map(mapping.map((r) => [r.target.id, r.targetName]));
  const startOf = new Map(sessions.map((s) => [s.id, s.startedAt]));
  const loads = new Map<string, number[]>();
  for (const s of sets) if (s.loadKg && s.loadKg > 0) loads.set(s.exerciseId, [...(loads.get(s.exerciseId) ?? []), s.loadKg]);
  const med = new Map([...loads].map(([k, v]) => [k, median(v)]));
  const heavy = sets.filter((s) => s.loadKg && (med.get(s.exerciseId) ?? 0) > 0 && s.loadKg > 3 * med.get(s.exerciseId)!);
  for (const s of heavy.slice(0, 8)) out.push(`${nameOf.get(s.exerciseId)} ${s.loadKg} kg on ${dateOf(startOf.get(s.sessionId)!)} (usually ${Math.round(med.get(s.exerciseId)!)} kg)`);
  if (heavy.length > 8) out.push(`…and ${heavy.length - 8} more sets over 3× their usual weight`);
  const reps = sets.filter((s) => (s.reps ?? 0) > 50);
  for (const s of reps.slice(0, 5)) out.push(`${nameOf.get(s.exerciseId)} ${s.reps} reps on ${dateOf(startOf.get(s.sessionId)!)}`);
  if (reps.length > 5) out.push(`…and ${reps.length - 5} more sets over 50 reps`);
  const long = sessions.filter((s) => (s.endedAt! - s.startedAt) > 4 * 3600000);
  for (const s of long.slice(0, 3)) out.push(`${s.name} on ${dateOf(s.startedAt)} lasted ${Math.round((s.endedAt! - s.startedAt) / 60000)} min`);
  const kcal = new Map<string, number>();
  for (const e of entries) kcal.set(e.date, (kcal.get(e.date) ?? 0) + e.n.kcal);
  for (const [d, k] of [...kcal].filter(([, k]) => k > 8000).slice(0, 5)) out.push(`${Math.round(k).toLocaleString('en')} kcal logged on ${d}`);
  for (const w of weights.filter((x) => x.kg < 30 || x.kg > 250).slice(0, 3)) out.push(`Weigh-in of ${w.kg} kg on ${dateOf(w.at)}`);
  const low = mapping.filter((r) => r.confidence === 'low').length;
  if (low) out.push(`${low} exercise${low === 1 ? '' : 's'} matched loosely: check the list`);
  return out;
}

/** Which of these records already exist (alive) or exist as tombstones (an undone import: revived). */
async function statusOf<T extends Base>(table: SyncedTable, recs: T[]): Promise<Map<string, Status>> {
  const found = await db.table(table).bulkGet(recs.map((r) => r.id)) as (T | undefined)[];
  return new Map(recs.map((r, i) => [r.id, !found[i] ? 'new' : found[i]!.deletedAt ? 'revive' : 'existing']));
}
const countBy = (m: Map<string, Status>) => { let n = 0, e = 0; for (const v of m.values()) v === 'existing' ? e++ : n++; return { new: n, existing: e }; };

async function summary(b: Built) {
  const [ex, pl, wo, se, st, bw, en] = await Promise.all([
    statusOf('exercises', b.exercises), statusOf('plans', b.plans), statusOf('workouts', b.workouts), statusOf('sessions', b.sessions),
    statusOf('sets', b.sets), statusOf('bodyweight', b.weights), statusOf('entries', b.entries),
  ]);
  const conf = { high: 0, medium: 0, low: 0, new: 0 } as Record<string, number>;
  for (const r of b.mapping) conf[r.confidence]++;
  const foodDays = new Set(b.entries.map((e) => e.date));
  return {
    status: { exercises: ex, plans: pl, workouts: wo, sessions: se, sets: st, bodyweight: bw, entries: en },
    out: {
      files: b.parsed.files,
      counts: {
        sessions: countBy(se), sets: countBy(st), plans: countBy(pl), workouts: countBy(wo),
        exercises: { mapped: b.mapping.length, ...conf, toCreate: countBy(ex).new },
        weighIns: { ...countBy(bw), duplicate: b.duplicateWeights },
        foodEntries: countBy(en), foodDays: foodDays.size, emptyWorkoutsSkipped: b.skippedEmpty,
      },
      ranges: {
        workouts: range(b.sessions.map((s) => dateOf(s.startedAt))), weighIns: range(b.weights.map((w) => dateOf(w.at))), food: range([...foodDays]),
      },
      mapping: b.mapping.map((r) => ({
        key: r.key, name: r.name, equipment: r.equipment, uses: r.uses, confidence: r.confidence, why: r.why, overridden: !!r.overridden,
        targetId: r.target.id, targetName: r.targetName, create: r.target.kind === 'create' && ex.get(r.target.id) !== 'existing', note: r.note ?? null,
      })),
      warnings: b.warnings,
    },
  };
}

// ---------------- commands ----------------
export const importPreview = defineCommand({
  name: 'import.preview', kind: 'query',
  description: 'Read export files from other apps (Alpha Progression CSVs: workouts, plans, custom exercises, measurements; MyNetDiary yearly .xls) and report what import.run would add, without writing: ' +
    'counts per kind (new vs already imported), date ranges, the exercise mapping (Alpha name → Tap In exercise, confidence high|medium|low|new, why; create = a new exercise would be made) and warnings (suspicious values). ' +
    'overrides fixes mapping rows by key.',
  input: zInput,
  run: async (input) => (await summary(await build(input))).out,
});
export type ImportPreview = Awaited<ReturnType<typeof importPreview.run>>;

/** The order records are written in (referenced records first). */
const ORDER = ['exercises', 'plans', 'workouts', 'sessions', 'sets', 'bodyweight', 'entries'] as const;

export const importRun = defineCommand({
  name: 'import.run', kind: 'action',
  description: 'Import the files (same input as import.preview, with the mapping overrides the user chose). Adds sessions with their sets, plans with their workouts, the exercises the mapping creates, weigh-ins (duplicates of ' +
    'existing ones skipped) and food entries; records already imported are skipped, undone ones come back. Returns importId (for import.undo) and counts written per kind.',
  input: zInput,
  run: async (input) => {
    progress({ phase: 'Reading', done: 0, total: 1 });
    try {
      const b = await build(input);
      const { status, out } = await summary(b);
      const importId = `imp-${Date.now().toString(36)}`;
      const lists: Record<(typeof ORDER)[number], Base[]> = {
        exercises: b.exercises, plans: b.plans, workouts: b.workouts, sessions: b.sessions, sets: b.sets, bodyweight: b.weights, entries: b.entries,
      };
      const todo = ORDER.map((t) => [t, lists[t].filter((r) => status[t].get(r.id) !== 'existing').map((r) => ({ ...r, importId, deletedAt: null }))] as const);
      const total = todo.reduce((a, [, l]) => a + l.length, 0);
      let done = 0;
      const written: Record<string, number> = {};
      for (const [t, list] of todo) {
        const before = done;
        written[t] = await saveMany(t, list, 500, (n) => { done = before + n; progress({ phase: t, done, total }); });
      }
      if (total) await db.meta.put({ key: `import:${importId}`, value: { at: Date.now(), files: b.parsed.files.map((f) => f.name) } }); // nothing new: no entry in import.list
      return { importId, written, skippedExisting: Object.fromEntries(ORDER.map((t) => [t, lists[t].length - written[t]])), weighInsDuplicate: b.duplicateWeights, warnings: out.warnings };
    } finally { progress(null); }
  },
});

const TABLES = ['entries', 'bodyweight', 'sets', 'sessions', 'workouts', 'plans', 'exercises'] as const;
export const importUndo = defineCommand({
  name: 'import.undo', kind: 'action',
  description: 'Undo one import (importId from import.list): deletes every session, set, plan, workout, weigh-in and food entry it added (soft delete, syncs), and the exercises it created unless something else still uses them. Returns counts removed.',
  input: z.object({ importId: z.string().min(1) }),
  run: async ({ importId }) => {
    const now = Date.now();
    const removed: Record<string, number> = {};
    const gone = new Set<string>();
    for (const t of TABLES) {
      let recs = (await db.table(t).where('importId').equals(importId).toArray() as Base[]).filter(alive);
      if (t === 'sets') {
        // sets added by hand to an imported session go with it
        const sess = new Set((await db.sessions.where('importId').equals(importId).toArray()).map((s) => s.id));
        const extra = (await db.sets.where('sessionId').anyOf([...sess]).toArray()).filter((s) => alive(s) && s.importId !== importId);
        recs = [...recs, ...extra];
      }
      if (t === 'exercises') {
        const used = new Set<string>();
        await db.sets.each((s) => { if (alive(s)) used.add(s.exerciseId); });
        for (const w of await db.workouts.toArray()) if (alive(w)) for (const i of w.items) used.add(i.exerciseId);
        for (const s of await db.sessions.toArray()) if (alive(s)) for (const i of s.items) used.add(i.exerciseId);
        recs = recs.filter((e) => !used.has(e.id));
      }
      removed[t] = await saveMany(t, recs.map((r) => ({ ...r, deletedAt: now })));
      if (t === 'plans') recs.forEach((r) => gone.add(r.id));
    }
    const s = await getSettings();
    if (s.activePlanId && gone.has(s.activePlanId)) await updateSettings({ activePlanId: undefined });
    return { importId, removed };
  },
});

export const importList = defineCommand({
  name: 'import.list', kind: 'query',
  description: 'Past file imports, newest first: importId, when, the files (on the device that ran it), and how many of its records are still in the app per kind (all 0 = undone).',
  input: z.object({}),
  run: async () => {
    const by = new Map<string, Record<string, number>>();
    for (const t of TABLES) {
      await db.table(t).where('importId').above('').each((r: Base) => {
        const c = by.get(r.importId!) ?? Object.fromEntries(TABLES.map((x) => [x, 0]));
        if (alive(r)) c[t]++;
        by.set(r.importId!, c);
      });
    }
    const metas = await db.meta.where('key').startsWith('import:').toArray();
    for (const m of metas) if (!by.has(m.key.slice(7))) by.set(m.key.slice(7), Object.fromEntries(TABLES.map((x) => [x, 0])));
    const metaOf = new Map(metas.map((m) => [m.key.slice(7), m.value as { at: number; files: string[] }]));
    return [...by].map(([importId, counts]) => {
      const meta = metaOf.get(importId);
      const at = meta?.at ?? parseInt(importId.replace(/^imp-/, ''), 36);
      return { importId, at: new Date(at).toISOString(), files: meta?.files ?? [], counts, undone: Object.values(counts).every((n) => n === 0) };
    }).sort((a, b) => b.at.localeCompare(a.at));
  },
});
