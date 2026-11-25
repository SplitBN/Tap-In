// Maps exercises named by another app (Alpha Progression: "Lat Pulldowns with Close Neutral Grip" · Cable) to Tap In
// exercises, deterministically, with a confidence level the import preview shows so the user can fix a wrong match:
//   high    same movement + equipment (after plural/alias normalisation), grip/width/handle fully represented
//   medium  same movement + equipment, but a grip/width word could not be represented, an approximate alias
//           (Seated Lateral Raises → Lateral Raise), or two Alpha exercises land on one Tap In exercise
//   low     only a looser name match (every word of the Tap In name appears in the Alpha name, same equipment)
//   new     nothing close: created as a custom exercise (muscles from the custom-exercise export when given)
// Pure (no db): the pool of exercises is passed in, so scripts/check-import.mjs runs it against src/data/exercises.json.
import type { Exercise, LoadType, Mechanic } from '../db/types';
import { searchExercises } from './exerciseRank.ts';
import { fitVariant, groupOf, normalizeVariant, variantFields, variantFromQuery, variantKey, type Variant } from './variants.ts';
import { stableHash, type AlphaCustom } from './importParse.ts';

export type Confidence = 'high' | 'medium' | 'low' | 'new';
export interface NewExercise {
  name: string; mechanic: Mechanic; equipment: string; loadType: LoadType; unilateral: boolean; muscles: string[]; secondary: string[];
  images: string[]; instructions?: string[]; stepKg?: number; custom: true; family?: string; variant?: Variant;
}
export type MapTarget =
  | { kind: 'existing'; id: string }
  /** a record to create: a variant of a Tap In family, or a custom exercise */
  | { kind: 'create'; id: string; spec: NewExercise };
export interface MapRow {
  /** `${name}|${equipment}` as Alpha writes it */ key: string;
  name: string; equipment: string;
  /** sessions it appears in */ uses: number;
  /** Alpha logs it as bodyweight + added load ("+15") */ added: boolean;
  target: MapTarget; targetName: string; confidence: Confidence; why: string;
  /** setup note from the custom-exercise export (goes on the exercise's plan and session slots) */ note?: string;
}
export interface AlphaRef { name: string; equipment: string; uses: number; added: boolean }

/** Alpha equipment → Tap In equipment value (lib/equipment.ts). */
export const EQUIPMENT: Record<string, string> = {
  cable: 'cable', machine: 'machine', barbell: 'barbell', dumbbells: 'dumbbell', dumbbell: 'dumbbell', bodyweight: 'body only',
  'smith machine': 'smith machine', 'ez bar': 'e-z curl bar', kettlebell: 'kettlebells', kettlebells: 'kettlebells', band: 'bands', bands: 'bands',
};
export const equipmentOf = (alpha: string) => EQUIPMENT[alpha.trim().toLowerCase()] ?? 'other';

/** Alpha muscle names → Tap In muscle vocabulary. */
export const MUSCLES: Record<string, string> = {
  chest: 'chest', 'front delts': 'shoulders', 'side delts': 'shoulders', 'rear delts': 'shoulders', shoulders: 'shoulders', delts: 'shoulders',
  triceps: 'triceps', biceps: 'biceps', forearms: 'forearms', lats: 'lats', 'upper back': 'middle back', 'middle back': 'middle back', traps: 'traps',
  'lower back': 'lower back', abs: 'abdominals', abdominals: 'abdominals', obliques: 'abdominals', core: 'abdominals', quads: 'quadriceps', quadriceps: 'quadriceps',
  hams: 'hamstrings', hamstrings: 'hamstrings', glutes: 'glutes', calves: 'calves', adductors: 'adductors', abductors: 'abductors', neck: 'traps',
};
export const muscleOf = (m: string) => MUSCLES[m.trim().toLowerCase()];

/** Alpha names that differ from Tap In's (keys: lower-case, singular, without the "with …" part; optionally per equipment).
 *  conf 'medium' = an approximation the user should glance at. */
const ALIAS: Record<string, { name: string; eq?: string; conf?: 'medium' }[]> = {
  butterfly: [{ name: 'Pec Deck' }],
  'reverse butterfly': [{ name: 'Reverse Fly' }],
  curl: [{ name: 'Bicep Curl' }],
  'seated curl': [{ name: 'Bicep Curl', conf: 'medium' }],
  'kneeling crunch': [{ name: 'Crunch', eq: 'cable' }],
  'standing shoulder press': [{ name: 'Overhead Press', eq: 'barbell' }],
  'seated shoulder press': [{ name: 'Shoulder Press', eq: 'dumbbell' }, { name: 'Shoulder Press', eq: 'smith machine' }, { name: 'Seated Overhead Press', eq: 'barbell' }],
  'calf raise on leg press': [{ name: 'Leg Press Calf Raise' }],
  'standing calf raise': [{ name: 'Calf Raise' }],
  'incline row': [{ name: 'Chest-Supported Row', eq: 'dumbbell' }],
  pullover: [{ name: 'Straight-Arm Pulldown', eq: 'cable', conf: 'medium' }, { name: 'Pullover', eq: 'dumbbell' }],
  'incline fly': [{ name: 'Incline Chest Fly' }],
  fly: [{ name: 'Chest Fly' }],
  'reverse fly': [{ name: 'Reverse Fly' }],
  'seated lateral raise': [{ name: 'Lateral Raise', eq: 'dumbbell', conf: 'medium' }],
  'face pull': [{ name: 'Face Pull' }],
  row: [{ name: 'Seated Cable Row', eq: 'cable' }],
  'seated row': [{ name: 'Seated Cable Row', eq: 'cable' }, { name: 'Seated Row', eq: 'machine' }],
  'chest supported row': [{ name: 'Seated Row', eq: 'machine', conf: 'medium' }],
  'chest supported high row': [{ name: 'High Row', eq: 'machine', conf: 'medium' }],
  'muscle up': [{ name: 'Muscle-Up' }],
  'wrist curl on bench': [{ name: 'Wrist Curl', eq: 'dumbbell', conf: 'medium' }],
  'standing wrist curl': [{ name: 'Wrist Curl', eq: 'cable', conf: 'medium' }],
  'hip thrust': [{ name: 'Hip Thrust' }],
  'skull crusher': [{ name: 'Skull Crusher' }],
  'leg raise': [{ name: 'Lying Leg Raise', eq: 'body only', conf: 'medium' }],
};
/** Words in a "with …" part that are the exercise's normal implement, so they lose nothing (Face Pulls with Rope). */
const IMPLIED: Record<string, string[]> = { 'Face Pull': ['rope'], 'Hammer Curl': ['rope'] };

/** "Lat Pulldowns" → "lat pulldown", "Pull-Ups" → "pull up", "Flys" → "fly", "Presses" → "press". */
export function singular(word: string) {
  const w = word.toLowerCase();
  if (w.length <= 2 || w.endsWith('ss') || w.endsWith('us')) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}
export const normName = (s: string) => s.toLowerCase().replace(/[-–_/]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean).map(singular).join(' ');
/** "X with Close Neutral Grip" → base "X", mods "Close Neutral Grip". */
export function splitWith(name: string) {
  const m = name.match(/^(.*?)\s+with\s+(.+)$/i);
  return m ? { base: m[1].trim(), mods: m[2].trim() } : { base: name.trim(), mods: '' };
}

const ISOLATION = /raise|curl|fly|flies|flys|extension|pushdown|kickback|crunch|shrug|butterfly|pullover|abduction|adduction|side bend|leg raise|calf|wrist/i;
/** Primary muscles guessed from the name, for a custom exercise without export metadata. */
function guessMuscles(name: string): string[] {
  const n = name.toLowerCase();
  const rules: [RegExp, string[]][] = [
    [/wrist|reverse curl/, ['forearms']], [/hammer/, ['biceps', 'forearms']], [/curl/, ['biceps']],
    [/tricep|pushdown|skull|jm press|kickback|dip/, ['triceps']], [/lateral|y raise|front raise|shoulder|delt|abduction|overhead press|military/, ['shoulders']],
    [/face pull|rear|reverse fl/, ['shoulders']], [/shrug/, ['traps']], [/pulldown|pull ?up|chin|pullover|lat\b/, ['lats']], [/row/, ['middle back']],
    [/bench|chest|press|fly|butterfly|push ?up/, ['chest']], [/rdl|romanian|deadlift|jefferson|good morning/, ['hamstrings']],
    [/squat|leg press|lunge|leg extension/, ['quadriceps']], [/leg curl/, ['hamstrings']], [/calf/, ['calves']], [/hip thrust|glute/, ['glutes']],
    [/adduct/, ['adductors']], [/crunch|leg raise|side bend|plank|ab\b/, ['abdominals']],
  ];
  for (const [re, m] of rules) if (re.test(n)) return m;
  return [];
}

/** Map every Alpha exercise (name + equipment) to a Tap In exercise. `pool` = the alive exercises (library + the user's). */
export function mapExercises(refs: AlphaRef[], pool: Exercise[], custom: AlphaCustom[] = []): MapRow[] {
  const byNameEq = new Map<string, Exercise[]>();
  for (const e of pool) {
    const k = `${normName(e.name)}|${e.equipment}`;
    byNameEq.set(k, [...(byNameEq.get(k) ?? []), e]);
  }
  const byId = new Map(pool.map((e) => [e.id, e]));
  const customOf = new Map(custom.map((c) => [`${c.name.toLowerCase()}|${equipmentOf(c.equipment)}`, c]));
  // prefer the library exercise over a same-named user copy, and the plain base of a variant group
  const pick = (list: Exercise[]) => [...list].sort((a, b) => Number(!!a.custom) - Number(!!b.custom) || Number(!!a.variant) - Number(!!b.variant) || a.id.localeCompare(b.id))[0];
  const rows = refs.map((ref): MapRow => {
    const eq = equipmentOf(ref.equipment);
    const key = `${ref.name}|${ref.equipment}`;
    const cust = customOf.get(`${ref.name.toLowerCase()}|${eq}`);
    const base: Omit<MapRow, 'target' | 'targetName' | 'confidence' | 'why'> = { key, name: ref.name, equipment: ref.equipment, uses: ref.uses, added: ref.added, ...(cust?.notes ? { note: cust.notes } : {}) };
    const createId = `ap:x:${stableHash(ref.name.toLowerCase(), eq)}`;
    // a previous run of this import already created it
    const mine = byId.get(createId);
    if (mine && !mine.deletedAt) return { ...base, target: { kind: 'existing', id: mine.id }, targetName: mine.name, confidence: 'high', why: 'Created by an earlier import' };

    const { base: baseName, mods } = splitWith(ref.name);
    const n = normName(baseName);
    const aliases = (ALIAS[n] ?? []).filter((a) => !a.eq || a.eq === eq);
    // a custom exercise from the export matches only by its whole name: its "with …" words are the user's own wording
    const tries: { name: string; conf?: 'medium'; via: string }[] = cust && mods ? [] : [
      ...aliases.map((a) => ({ name: normName(a.name), conf: a.conf, via: 'alias' })),
      { name: n, via: 'name' },
    ];
    // the user's own exercises of the same name (e.g. made by hand in Tap In before importing) count as exact too
    for (const t of tries) {
      const list = byNameEq.get(`${t.name}|${eq}`);
      if (!list?.length) continue;
      const e = pick(list);
      const r = withVariant(e, mods, pool);
      const conf: Confidence = r.dropped || t.conf ? 'medium' : 'high';
      const loadWarn = ref.added && e.loadType === 'weighted';
      const why = [t.via === 'alias' ? `Same movement in Tap In` : 'Same name and equipment', r.dropped ? `“${mods}” not tracked separately` : '', loadWarn ? 'Alpha logs it as bodyweight + added load' : ''].filter(Boolean).join(' · ');
      return { ...base, ...r.target, confidence: loadWarn ? 'low' : conf, why };
    }
    // the user's custom exercise: create it with its own metadata (no fuzzy guessing for these)
    if (!cust) {
      const fuzzy = fuzzyMatch(ref.name, eq, pool);
      if (fuzzy) {
        const loadWarn = ref.added && fuzzy.loadType === 'weighted';
        return { ...base, target: { kind: 'existing', id: fuzzy.id }, targetName: fuzzy.name, confidence: 'low', why: `Closest name${loadWarn ? ' · Alpha logs it as bodyweight + added load' : ''}` };
      }
    }
    const spec = customSpec(ref, eq, cust);
    return { ...base, target: { kind: 'create', id: createId, spec }, targetName: spec.name, confidence: 'new', why: cust ? 'Your custom exercise' : 'No match in Tap In' };
  });
  // two Alpha exercises on one Tap In exercise merge their histories: flag every one but the most exact
  const byTarget = new Map<string, MapRow[]>();
  for (const r of rows) byTarget.set(r.target.id, [...(byTarget.get(r.target.id) ?? []), r]);
  for (const list of byTarget.values()) {
    if (list.length < 2) continue;
    const rank = (r: MapRow) => (r.confidence === 'high' ? 0 : r.confidence === 'medium' ? 1 : 2) * 10 + (splitWith(r.name).mods ? 0 : 1);
    const best = [...list].sort((a, b) => rank(a) - rank(b) || b.uses - a.uses)[0];
    for (const r of list) {
      if (r === best) continue;
      if (r.confidence === 'high') r.confidence = 'medium';
      r.why = `${r.why} · Shares history with “${best.name}”`;
    }
  }
  return rows;
}

/** Resolve the grip/width/handle words of an Alpha name inside e's variant group (existing record, or one to create). */
function withVariant(e: Exercise, mods: string, pool: Exercise[]): { target: { target: MapTarget; targetName: string }; dropped: boolean } {
  const g = groupOf(e);
  const words = mods ? variantFromQuery(mods) : {};
  const implied = (IMPLIED[e.name] ?? []).some((w) => mods.toLowerCase().includes(w)) && Object.keys(words).length <= 1;
  if (!g) return { target: { target: { kind: 'existing', id: e.id }, targetName: e.name }, dropped: !!mods && !implied };
  const fitted = fitVariant(g, { ...(e.variant ?? {}), ...words }) ?? {};
  let dropped = Object.keys(words).some((k) => !(k in fitted) || (fitted as Record<string, string>)[k] !== (words as Record<string, string>)[k]);
  if (mods && !Object.keys(words).length) dropped = true; // "with Back to Wall": words we don't model at all
  let want: Variant = fitted;
  try { normalizeVariant(g, want); } catch { want = {}; dropped = true; } // e.g. a V-handle asked for wide: keep the base
  const key = variantKey(g, want);
  const members = pool.filter((x) => !x.deletedAt && x.family === e.family && x.equipment === e.equipment);
  const hit = members.find((m) => variantKey(g, m.variant) === key);
  if (hit) return { target: { target: { kind: 'existing', id: hit.id }, targetName: hit.name }, dropped };
  const baseEx = members.find((m) => !m.variant) ?? e;
  const spec = variantFields(baseEx, e.family!, want) as NewExercise;
  return { target: { target: { kind: 'create', id: `ap:v:${stableHash(e.family!, e.equipment, key)}`, spec }, targetName: spec.name }, dropped };
}

/** A looser match: the top search hit with the same equipment whose every name word appears in the Alpha name. */
function fuzzyMatch(name: string, eq: string, pool: Exercise[]): Exercise | undefined {
  const q = normName(splitWith(name).base);
  const qWords = new Set(q.split(' '));
  const same = pool.filter((e) => !e.deletedAt && e.equipment === eq);
  const hits = searchExercises(same, q, undefined, 5);
  return hits.find((e) => { const w = normName(e.name).split(' '); return w.length >= 2 && w.every((x) => qWords.has(x)); })
    ?? hits.find((e) => normName(e.name) === q);
}

/** The "create as custom" choice for a row (the user overrode the match). */
export function asCustomTarget(ref: AlphaRef, custom: AlphaCustom[] = []): Extract<MapTarget, { kind: 'create' }> {
  const eq = equipmentOf(ref.equipment);
  const cust = custom.find((c) => c.name.toLowerCase() === ref.name.toLowerCase() && equipmentOf(c.equipment) === eq);
  return { kind: 'create', id: `ap:x:${stableHash(ref.name.toLowerCase(), eq)}`, spec: customSpec(ref, eq, cust) };
}

function customSpec(ref: AlphaRef, eq: string, cust?: AlphaCustom): NewExercise {
  const muscles = cust ? [cust.muscle, ...cust.aux].map(muscleOf).filter(Boolean) as string[] : [];
  const prime = cust ? [muscleOf(cust.muscle)].filter(Boolean) as string[] : guessMuscles(ref.name);
  const secondary = [...new Set(muscles.filter((m) => !prime.includes(m)))];
  const mechanic: Mechanic = cust ? (/small/i.test(cust.type) ? 'isolation' : 'compound') : ISOLATION.test(ref.name) ? 'isolation' : 'compound';
  const pretty = ref.name.charAt(0).toUpperCase() + ref.name.slice(1);
  return {
    name: pretty, mechanic, equipment: eq, loadType: ref.added || eq === 'body only' ? 'bodyweight' : 'weighted',
    unilateral: /single hand|single arm|one arm|one-arm|unilateral/i.test(ref.name), muscles: prime, secondary, images: [], custom: true,
  };
}

/** Distinct Alpha exercises with how many workouts each appears in, and whether it's logged as bodyweight + added load. */
export function collectRefs(workouts: { exercises: { name: string; equipment: string; sets: { added: boolean }[] }[] }[], plans: { days: { items: { name: string; equipment: string }[] }[] }[] = []): AlphaRef[] {
  const m = new Map<string, AlphaRef>();
  for (const w of workouts) {
    const seen = new Set<string>();
    for (const x of w.exercises) {
      const k = `${x.name}|${x.equipment}`;
      const r = m.get(k) ?? { name: x.name, equipment: x.equipment, uses: 0, added: false };
      if (!seen.has(k)) { r.uses++; seen.add(k); }
      if (x.sets.some((s) => s.added)) r.added = true;
      m.set(k, r);
    }
  }
  for (const p of plans) for (const d of p.days) for (const it of d.items) {
    const k = `${it.name}|${it.equipment}`;
    if (!m.has(k)) m.set(k, { name: it.name, equipment: it.equipment, uses: 0, added: false });
  }
  return [...m.values()].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}
