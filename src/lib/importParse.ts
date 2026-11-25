// Parsers for other apps' exports (Settings → Import): Alpha Progression CSVs (workouts, plans, custom exercises,
// measurements) and MyNetDiary yearly .xls sheets (rows already read by SheetJS in api/import.ts).
// Pure (no db / browser APIs; erasable TS, `.ts` imports) so scripts/check-import.mjs runs it in Node on a synthetic fixture.
import type { Macros, Meal } from '../db/types';

export type ImportKind = 'alpha-workouts' | 'alpha-plans' | 'alpha-custom' | 'alpha-measurements' | 'mnd' | 'unknown';

export interface AlphaSet { load: number | null; reps: number | null; /** "+15" = added load on a bodyweight lift */ added: boolean }
export interface AlphaExercise { name: string; equipment: string; reps: [number, number] | null; drops: number; superset: number | null; sets: AlphaSet[] }
export interface AlphaWorkout {
  /** workout name ("Back"), or "Workout" for a nameless standalone one */ name: string;
  day: number | null; week: number | null; plan: string | null;
  date: string; time: string; durationMin: number; exercises: AlphaExercise[];
}
export interface AlphaPlanItem { name: string; equipment: string; sets: number; reps: [number, number] | null; drops: number; superset: number | null }
export interface AlphaPlan { name: string; startDate: string; days: { day: number; name: string; items: AlphaPlanItem[] }[] }
export interface AlphaCustom { name: string; equipment: string; muscle: string; aux: string[]; type: string; notes: string }
export interface WeighIn { date: string; time: string; kg: number; source: 'alpha' | 'mnd' }
export interface MndFood { date: string; time: string | null; meal: Meal; name: string; amount: string; n: Macros }

// ---------------- CSV ----------------
/** RFC-4180-ish rows: `sep`-separated, double quotes with "" escapes, newlines inside quotes kept. Strips a UTF-8 BOM. */
export function csvRows(text: string, sep = ';'): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false, quoted = false;
  const endCell = () => { row.push(quoted ? cell : cell.trim()); cell = ''; quoted = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') { q = true; quoted = true; }
    else if (ch === sep) endCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      endCell(); rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell || quoted || row.length) { endCell(); rows.push(row); }
  return rows.map((r) => (r.length === 1 && r[0] === '' ? [] : r));
}

// ---------------- small helpers ----------------
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i;
/** "2026-11-13 4:23 pm" → { date, time: "16:23" } */
export function parseDateTime(v: string): { date: string; time: string } | null {
  const m = v.trim().match(DATE_TIME);
  if (!m) return null;
  let h = +m[2];
  const ap = m[4]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { date: m[1], time: `${String(h).padStart(2, '0')}:${m[3]}` };
}
/** "51 min", "1:06 hr", "1 hr", "45 sec" → minutes */
export function parseDuration(v: string): number {
  const s = v.trim().toLowerCase();
  let m = s.match(/^(\d+):(\d{2})\s*hr?s?$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(\d+(?:\.\d+)?)\s*(hr|hrs|hour|hours|h)$/);
  if (m) return Math.round(+m[1] * 60);
  m = s.match(/^(\d+)\s*(min|mins|m)$/);
  if (m) return +m[1];
  m = s.match(/^(\d+)\s*(sec|s)$/);
  if (m) return Math.max(1, Math.round(+m[1] / 60));
  return 0;
}
const num = (v: string | undefined) => { if (v == null) return null; const t = v.trim().replace(',', '.'); return t === '' || !Number.isFinite(+t) ? null : +t; };

/** "1. Lat Pulldowns with Close Neutral Grip · Cable · 10 reps · Superset 1 · 1 dropset" → parts. */
function exerciseParts(label: string) {
  const parts = label.replace(/^\s*\d+\.\s*/, '').split(' · ').map((p) => p.trim());
  const out = { name: parts[0] ?? '', equipment: parts[1] ?? '', reps: null as [number, number] | null, drops: 0, superset: null as number | null };
  for (const p of parts.slice(2)) {
    let m = p.match(/^(\d+)(?:\s*[-–]\s*(\d+))?\s*reps?$/i);
    if (m) { out.reps = [+m[1], m[2] ? +m[2] : +m[1]]; continue; }
    m = p.match(/^(\d+)\s*dropsets?$/i);
    if (m) { out.drops = +m[1]; continue; }
    m = p.match(/^superset\s*(\d+)$/i);
    if (m) out.superset = +m[1];
  }
  return out;
}

// ---------------- Alpha Progression ----------------
/** Workouts export: header row `"<Workout> · Day N · Week W · <Plan>";"<date time>";"<duration>"`, then per exercise a label row,
 *  a column row (`#;KG;REPS` or `#;REPS`) and one row per set. Exercises without set rows are dropped. */
export function parseAlphaWorkouts(text: string): AlphaWorkout[] {
  const out: AlphaWorkout[] = [];
  let w: AlphaWorkout | null = null, ex: AlphaExercise | null = null, cols: string[] = [];
  const flushEx = () => { if (w && ex && ex.sets.length) w.exercises.push(ex); ex = null; };
  for (const r of csvRows(text)) {
    if (!r.length) continue;
    const dt = r.length >= 2 ? parseDateTime(r[1]) : null;
    if (dt && r.length >= 3) {
      flushEx();
      const parts = r[0].split(' · ').map((p) => p.trim());
      // the "Day N" just before "Week N" (a workout without its own name repeats it: "Day 1 · Day 1 · Week 1 · Plan")
      const wi = parts.findIndex((p) => /^Week \d+$/i.test(p));
      const isDay = (p: string) => /^Day \d+$/i.test(p);
      const di = wi > 0 && isDay(parts[wi - 1]) ? wi - 1 : parts.findIndex(isDay);
      let name = parts[0] || 'Workout', plan: string | null = null, day: number | null = null, week: number | null = null;
      if (di >= 0 && (di > 0 || wi === 1)) {
        name = parts.slice(0, di).join(' · ') || parts[di];
        day = +parts[di].replace(/\D/g, '');
        if (wi > di) { week = +parts[wi].replace(/\D/g, ''); plan = parts.slice(wi + 1).join(' · ') || null; }
        else plan = parts.slice(di + 1).join(' · ') || null;
      } else if (parts.some((p) => /^standalone workout$/i.test(p))) {
        name = parts.find((p) => !/^standalone workout$/i.test(p)) ?? 'Workout';
      } else name = parts.join(' · ');
      w = { name, day, week, plan, date: dt.date, time: dt.time, durationMin: parseDuration(r[2] ?? ''), exercises: [] };
      out.push(w);
      continue;
    }
    if (!w) continue;
    if (r[0] === '#') { cols = r.map((c) => c.trim().toUpperCase()); continue; }
    if (/^\d+\.\s.+ · /.test(r[0]) && !parseDateTime(r[1] ?? '')) { // label row (stray extra cells seen in real exports are ignored)
      flushEx();
      const p = exerciseParts(r[0]);
      ex = { ...p, sets: [] };
      cols = [];
      continue;
    }
    if (ex && /^\d+$/.test(r[0])) {
      const ki = cols.indexOf('KG'), li = cols.indexOf('LBS'), ri = cols.indexOf('REPS');
      const rawLoad = ki >= 0 ? r[ki] : li >= 0 ? r[li] : undefined;
      const added = !!rawLoad && rawLoad.trim().startsWith('+');
      let load = num(rawLoad?.replace(/^\+/, ''));
      if (load != null && li >= 0 && ki < 0) load = Math.round(load * 0.45359237 * 100) / 100;
      (ex as AlphaExercise).sets.push({ load, reps: num(ri >= 0 ? r[ri] : r[r.length - 1]), added });
    }
  }
  flushEx();
  return out;
}

/** Plans export: `"<Plan>";<YYYY-MM-DD>`, then `"Day N · <Workout>"`, then `"1. <Exercise> · <Equipment>";"2 sets";["1 dropset";]"10 reps"`. */
export function parseAlphaPlans(text: string): AlphaPlan[] {
  const out: AlphaPlan[] = [];
  let plan: AlphaPlan | null = null;
  for (const r of csvRows(text)) {
    if (!r.length) continue;
    if (r.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(r[1].trim()) && !/^\d+\.\s/.test(r[0])) {
      plan = { name: r[0].trim(), startDate: r[1].trim(), days: [] };
      out.push(plan);
      continue;
    }
    if (!plan) continue;
    const dm = r.length === 1 ? r[0].match(/^Day\s+(\d+)\s*·\s*(.+)$/i) : null;
    if (dm) { plan.days.push({ day: +dm[1], name: dm[2].trim(), items: [] }); continue; }
    if (/^\d+\.\s/.test(r[0]) && plan.days.length) {
      const p = exerciseParts(r[0]);
      let sets = 0;
      for (const c of r.slice(1)) {
        let m = c.match(/^(\d+)\s*sets?$/i);
        if (m) { sets = +m[1]; continue; }
        m = c.match(/^(\d+)\s*dropsets?$/i);
        if (m) { p.drops = +m[1]; continue; }
        m = c.match(/^(\d+)(?:\s*[-–]\s*(\d+))?\s*reps?$/i);
        if (m) p.reps = [+m[1], m[2] ? +m[2] : +m[1]];
      }
      plan.days[plan.days.length - 1].items.push({ name: p.name, equipment: p.equipment, sets, reps: p.reps, drops: p.drops, superset: p.superset });
    }
  }
  return out;
}
/** "High Freq 6 · 17 weeks" → "High Freq 6" (the name workouts use for their plan). */
export const planBaseName = (name: string) => name.replace(/\s*·\s*\d+\s*weeks?\s*$/i, '').trim();

/** Custom exercises export: NAME;EQUIPMENT;MUSCLE;"AUXILIARY MUSCLES";TYPE;METRICS;BODYWEIGHT;NOTES */
export function parseAlphaCustom(text: string): AlphaCustom[] {
  const rows = csvRows(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toUpperCase());
  const col = (n: string) => head.indexOf(n);
  const [ni, ei, mi, ai, ti, nti] = [col('NAME'), col('EQUIPMENT'), col('MUSCLE'), col('AUXILIARY MUSCLES'), col('TYPE'), col('NOTES')];
  return rows.slice(1).filter((r) => r[ni]?.trim()).map((r) => ({
    name: r[ni].trim(), equipment: (r[ei] ?? '').trim(), muscle: (r[mi] ?? '').trim(),
    aux: (r[ai] ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== '-'),
    type: (r[ti] ?? '').trim(),
    notes: (r[nti] ?? '').replace(/<br\s*\/?>/gi, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join(' · '),
  }));
}

/** Measurements export: a "Bodyweight" title row, then DATE;KG rows. Other measurement blocks are ignored. */
export function parseAlphaMeasurements(text: string): WeighIn[] {
  const out: WeighIn[] = [];
  let block = '', unit = 'KG';
  for (const r of csvRows(text)) {
    if (!r.length) continue;
    if (r.length === 1 && !parseDateTime(r[0])) { block = r[0].trim().toLowerCase(); continue; }
    if (r[0].trim().toUpperCase() === 'DATE') { unit = (r[1] ?? 'KG').trim().toUpperCase(); continue; }
    const dt = parseDateTime(r[0]);
    const v = num(r[1]);
    if (!dt || v == null || !/body ?weight|weight/.test(block)) continue;
    out.push({ ...dt, kg: unit === 'LBS' || unit === 'LB' ? Math.round(v * 0.45359237 * 10) / 10 : v, source: 'alpha' });
  }
  return out;
}

// ---------------- MyNetDiary ----------------
type Cell = string | number | boolean | null | undefined;
/** Excel serial day (1900 system; may carry a time fraction) → local date + time (null when the fraction is 0). */
export function excelSerial(v: number): { date: string; time: string | null } {
  const days = Math.floor(v);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000); // pure day arithmetic in UTC, read back as Y/M/D
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const mins = Math.round((v - days) * 1440);
  return { date, time: mins > 0 && mins < 1440 ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` : null };
}
const MEALS: Record<string, Meal> = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snacks: 'snacks', snack: 'snacks', supper: 'dinner' };
const cellNum = (v: Cell) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
/** Header row lookup: exact name first, then by prefix ("Calories, cals" ← "Calories"). */
function colOf(head: Cell[], ...names: string[]) {
  const h = head.map((x) => String(x ?? '').trim().toLowerCase());
  for (const n of names) { const i = h.indexOf(n.toLowerCase()); if (i >= 0) return i; }
  for (const n of names) { const i = h.findIndex((x) => x.startsWith(n.toLowerCase())); if (i >= 0) return i; }
  return -1;
}
/** Food sheet rows (header first) → entries. Missing nutrient cells count as 0. */
export function mndFood(rows: Cell[][]): MndFood[] {
  const head = rows[0] ?? [];
  const c = { at: colOf(head, 'Date & Time', 'Date'), meal: colOf(head, 'Meal'), name: colOf(head, 'Name'), amount: colOf(head, 'Amount'),
    kcal: colOf(head, 'Calories, cals', 'Calories'), f: colOf(head, 'Total Fat, g'), carb: colOf(head, 'Total Carbs, g'), fiber: colOf(head, 'Dietary Fiber, g'), p: colOf(head, 'Protein, g') };
  if (c.at < 0 || c.name < 0 || c.kcal < 0) return [];
  const out: MndFood[] = [];
  for (const r of rows.slice(1)) {
    const at = r[c.at];
    if (typeof at !== 'number') continue;
    const { date, time } = excelSerial(at);
    const name = String(r[c.name] ?? '').trim();
    if (!name) continue;
    out.push({
      date, time, meal: MEALS[String(r[c.meal] ?? '').trim().toLowerCase()] ?? 'snacks', name, amount: String(r[c.amount] ?? '').trim(),
      n: { kcal: Math.round(cellNum(r[c.kcal])), p: r1(cellNum(r[c.p])), c: r1(cellNum(r[c.carb])), f: r1(cellNum(r[c.f])), fiber: r1(cellNum(r[c.fiber])) },
    });
  }
  return out;
}
/** Measurements sheet rows (header first) → body weight entries (BMR, BMI, … ignored). */
export function mndWeights(rows: Cell[][]): WeighIn[] {
  const head = rows[0] ?? [];
  const c = { at: colOf(head, 'Date'), what: colOf(head, 'Measurement'), v: colOf(head, 'Value'), unit: colOf(head, 'Unit') };
  if (c.at < 0 || c.what < 0 || c.v < 0) return [];
  const out: WeighIn[] = [];
  for (const r of rows.slice(1)) {
    if (typeof r[c.at] !== 'number' || !/^body ?weight$/i.test(String(r[c.what] ?? '').trim())) continue;
    const v = cellNum(r[c.v]);
    if (!v) continue;
    const { date, time } = excelSerial(r[c.at] as number);
    const lb = /^lbs?$/i.test(String(r[c.unit] ?? '').trim());
    out.push({ date, time: time ?? '08:00', kg: lb ? r1(v * 0.45359237) : v, source: 'mnd' });
  }
  return out;
}

// ---------------- detection ----------------
/** What a file is, from its name and first text (CSV) or first bytes (xls/xlsx). */
export function detectKind(name: string, head: string | Uint8Array): ImportKind {
  if (head instanceof Uint8Array) {
    const cfb = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0; // legacy .xls
    const zip = head[0] === 0x50 && head[1] === 0x4b; // .xlsx
    return cfb || zip || /\.xlsx?$/i.test(name) ? 'mnd' : 'unknown';
  }
  const rows = csvRows(head.slice(0, 4000)).filter((r) => r.length);
  const first = rows[0] ?? [];
  if (first[0]?.toUpperCase() === 'NAME' && first.some((c) => c.toUpperCase() === 'EQUIPMENT')) return 'alpha-custom';
  if (rows.some((r) => r[0]?.toUpperCase() === 'DATE' && /^(KG|LBS?)$/i.test(r[1] ?? ''))) return 'alpha-measurements';
  if (first.length >= 3 && parseDateTime(first[1] ?? '')) return 'alpha-workouts';
  if (first.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(first[1] ?? '')) return 'alpha-plans';
  return 'unknown';
}

// ---------------- stable ids ----------------
/** 53-bit string hash (cyrb53). Two seeds → 26 hex chars: stable record ids, so re-running an import never duplicates. */
function cyrb53(str: string, seed: number) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
export const stableHash = (...parts: (string | number)[]) => { const s = parts.join('␟'); return (cyrb53(s, 1) + cyrb53(s, 7)).slice(0, 26); };
