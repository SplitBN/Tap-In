// Builds src/data/exercises.json from free-exercise-db (public domain / Unlicense), curated by exercise-curation.mjs.
// Source: https://github.com/yuhonas/free-exercise-db  (dist/exercises.json)
// Usage (from the app folder): node scripts/build-exercises.mjs <path-to-exercises.json>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ADD, DROP, EQUIPMENT, KEEP, MUSCLES, REQUIRED } from './exercise-curation.mjs';
import { FAMILIES, baseRecordName, familyFor, groupKey, storedVariant, variantKey, variantMuscles } from '../src/lib/variants.ts';

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
  // variant groups (src/lib/variants.ts): a base by its name, a seeded variant by its overrides
  const family = o.family ?? familyFor(name, equipment);
  const group = family && FAMILIES[family]?.groups[equipment];
  if (o.family && !group) errors.push(`${id}: family ${o.family} has no ${equipment} group`);
  let variant;
  try { variant = group ? storedVariant(group, o.variant) : undefined; } catch (err) { errors.push(`${id}: ${err.message}`); }
  // MUSCLES corrections by name, then the variant's measured emphasis (variantMuscles); secondary never repeats a primary
  const m = variantMuscles(family, equipment, variant, { muscles: MUSCLES[name]?.muscles ?? s.primaryMuscles, secondary: MUSCLES[name]?.secondary ?? s.secondaryMuscles });
  return {
    id, name,
    mechanic: o.mechanic ?? (s.mechanic === 'isolation' ? 'isolation' : 'compound'),
    equipment,
    muscles: m.muscles,
    secondary: [...new Set(m.secondary)].filter((x) => !m.muscles.includes(x)),
    ...(group ? { family } : {}),
    ...(variant ? { variant } : {}),
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
// each variant group: exactly one base, no two records for the same variant
const groups = new Map();
for (const e of out) if (e.family) groups.set(groupKey(e), [...(groups.get(groupKey(e)) ?? []), e]);
for (const [k, list] of groups) {
  const g = FAMILIES[list[0].family].groups[list[0].equipment];
  if (list.filter((e) => !e.variant).length !== 1) errors.push(`variant group ${k}: needs exactly one base, has ${list.filter((e) => !e.variant).map((e) => e.id).join(', ') || 'none'}`);
  const keys = new Map();
  for (const e of list) { const vk = variantKey(g, e.variant); if (keys.has(vk)) errors.push(`variant group ${k}: ${keys.get(vk)} and ${e.id} are the same variant (${vk})`); keys.set(vk, e.id); }
}
for (const [slug, f] of Object.entries(FAMILIES)) for (const eq of Object.keys(f.groups)) if (!groups.has(`${slug}|${eq}`)) errors.push(`FAMILIES.${slug}: no ${eq} base exercise named ${f.name}`);
for (const n of Object.keys(MUSCLES)) if (!out.some((e) => e.name === n)) errors.push(`MUSCLES: no exercise named ${n}`);
for (const n of REQUIRED) if (!out.some((e) => e.name === n)) errors.push(`required exercise missing: ${n}`);
// equipment words belong in the equipment field, except where they are part of the movement's own name
const EQUIP_WORD = /\b(barbell|dumbbell|machine|smith|ez|e-z|kettlebell)\b|\bcable\b(?! (crossover|row))/i;
const ALLOWED = new Set(['Kettlebell Swing', 'Low Cable Crossover', 'Seated Cable Row', 'Cable Crossover']);
for (const e of out) if (EQUIP_WORD.test(e.name) && !ALLOWED.has(e.name)) console.warn(`warning: equipment word in name: ${e.name} (${e.equipment})`);

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

// a base whose group has a handle axis names its default handle (after the name-keyed curation checks above)
for (const e of out) if (e.family && !e.variant) e.name = baseRecordName(e.name, FAMILIES[e.family].groups[e.equipment]);
mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/exercises.json', JSON.stringify(out));
console.log(`${pool.length} source → ${out.length} exercises (${out.length - ADD.length} kept, ${ADD.length} added);`,
  out.filter((e) => e.unilateral).length, 'unilateral;',
  Object.entries(out.reduce((a, e) => ((a[e.loadType] = (a[e.loadType] || 0) + 1), a), {})));
console.log(`${groups.size} variant groups, ${out.filter((e) => e.variant).length} seeded variants`);
console.log('dropped:', Object.fromEntries(Object.entries(DROP).map(([k, v]) => [k, v.length])), 'total', dropped.size);
console.log('by equipment:', Object.fromEntries(EQUIPMENT.map((q) => [q, out.filter((e) => e.equipment === q).length])));
