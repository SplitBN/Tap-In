// Builds src/data/exercises.json from free-exercise-db (public domain / Unlicense), curated by exercise-curation.mjs.
// Source: https://github.com/yuhonas/free-exercise-db  (dist/exercises.json)
// Usage (from the app folder): node scripts/build-exercises.mjs <path-to-exercises.json>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ADD, DROP, EQUIPMENT, KEEP, REQUIRED } from './exercise-curation.mjs';

const src = process.argv[2];
if (!src) throw new Error('pass the path to free-exercise-db dist/exercises.json');
const raw = JSON.parse(readFileSync(src, 'utf8'));

const CATEGORIES = new Set(['strength', 'powerlifting', 'olympic weightlifting', 'strongman']);
const UNILATERAL = /\b(one|single)[- ]?(arm|leg|hand(ed)?)\b|alternat|bulgarian|lunge|split squat|step[- ]?up|unilateral|pistol|side bend|kneeling one/i;

function loadType(name, equipment) {
  const n = name.toLowerCase();
  if (n.includes('assisted')) return 'assisted';
  if (equipment === 'body only' || n.includes('weighted') || /\b(pull|chin)[- ]?ups?\b|\bdips?\b|push[- ]?ups?/.test(n)) return 'bodyweight';
  return 'weighted';
}

const errors = [];
const pool = raw.filter((e) => CATEGORIES.has(e.category));
const byId = new Map(raw.map((e) => [e.id, e]));
const dropped = new Map(Object.entries(DROP).flatMap(([why, ids]) => ids.map((id) => [id, why])));

for (const id of Object.keys(KEEP)) {
  if (!byId.has(id)) errors.push(`KEEP: unknown source id ${id}`);
  if (dropped.has(id)) errors.push(`${id} is in both KEEP and DROP (${dropped.get(id)})`);
}
for (const id of dropped.keys()) if (!byId.has(id)) errors.push(`DROP: unknown source id ${id}`);
for (const e of pool) if (!KEEP[e.id] && !dropped.has(e.id)) errors.push(`unreviewed source exercise: '${e.id}' (${e.name}) — add it to KEEP or DROP`);

const build = (id, s, name, o = {}) => {
  const equipment = o.equipment ?? s.equipment ?? 'other';
  return {
    id, name,
    mechanic: o.mechanic ?? (s.mechanic === 'isolation' ? 'isolation' : 'compound'),
    equipment,
    muscles: s.primaryMuscles,
    secondary: s.secondaryMuscles,
    loadType: o.loadType ?? loadType(name, equipment),
    unilateral: o.unilateral ?? UNILATERAL.test(name),
    images: s.images,
    instructions: s.instructions,
  };
};

const out = [
  ...pool.filter((e) => KEEP[e.id]).map((e) => {
    const k = KEEP[e.id];
    const [name, o] = typeof k === 'string' ? [k, {}] : k;
    return build('fedb:' + e.id, e, name, o);
  }),
  ...ADD.map(({ id, name, from, ...o }) => {
    const s = byId.get(from);
    if (!s) { errors.push(`ADD ${id}: unknown source id ${from}`); return null; }
    return build(id, s, name, o);
  }).filter(Boolean),
].sort((a, b) => a.name.localeCompare(b.name) || EQUIPMENT.indexOf(a.equipment) - EQUIPMENT.indexOf(b.equipment));

const seen = new Map();
for (const e of out) {
  if (!EQUIPMENT.includes(e.equipment)) errors.push(`${e.id}: equipment "${e.equipment}" is not in EQUIPMENT`);
  const key = `${e.name.toLowerCase()}|${e.equipment}`;
  if (seen.has(key)) errors.push(`duplicate (name, equipment): ${e.name} / ${e.equipment} — ${seen.get(key)} and ${e.id}`);
  seen.set(key, e.id);
}
for (const n of REQUIRED) if (!out.some((e) => e.name === n)) errors.push(`required exercise missing: ${n}`);
// equipment words belong in the equipment field, except where they are part of the movement's own name
const EQUIP_WORD = /\b(barbell|dumbbell|machine|smith|ez|e-z|kettlebell)\b|\bcable\b(?! (crossover|row))/i;
const ALLOWED = new Set(['Kettlebell Swing', 'Low Cable Crossover', 'Seated Cable Row', 'Cable Crossover']);
for (const e of out) if (EQUIP_WORD.test(e.name) && !ALLOWED.has(e.name)) console.warn(`warning: equipment word in name: ${e.name} (${e.equipment})`);

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/exercises.json', JSON.stringify(out));
console.log(`${pool.length} source → ${out.length} exercises (${out.length - ADD.length} kept, ${ADD.length} added);`,
  out.filter((e) => e.unilateral).length, 'unilateral;',
  Object.entries(out.reduce((a, e) => ((a[e.loadType] = (a[e.loadType] || 0) + 1), a), {})));
console.log('dropped:', Object.fromEntries(Object.entries(DROP).map(([k, v]) => [k, v.length])), 'total', dropped.size);
console.log('by equipment:', Object.fromEntries(EQUIPMENT.map((q) => [q, out.filter((e) => e.equipment === q).length])));
