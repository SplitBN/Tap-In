// Builds src/data/exercises.json from free-exercise-db (public domain / Unlicense).
// Source: https://github.com/yuhonas/free-exercise-db  (dist/exercises.json)
// Usage: node scripts/build-exercises.mjs <path-to-exercises.json>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = process.argv[2];
if (!src) throw new Error('pass the path to free-exercise-db dist/exercises.json');
const raw = JSON.parse(readFileSync(src, 'utf8'));

const KEEP = new Set(['strength', 'powerlifting', 'olympic weightlifting', 'strongman']);
const UNILATERAL = /\b(one|single)[- ]?(arm|leg|hand(ed)?)\b|alternat|bulgarian|lunge|split squat|step[- ]?up|unilateral|pistol|side bend|kneeling one/i;

function loadType(e) {
  const n = e.name.toLowerCase();
  if (n.includes('assisted')) return 'assisted';
  if (e.equipment === 'body only' || n.includes('weighted') || /\b(pull|chin)[- ]?ups?\b|\bdips?\b|push[- ]?ups?/.test(n)) return 'bodyweight';
  return 'weighted';
}

const out = raw
  .filter((e) => KEEP.has(e.category))
  .map((e) => ({
    id: 'fedb:' + e.id,
    name: e.name,
    mechanic: e.mechanic === 'isolation' ? 'isolation' : 'compound',
    equipment: e.equipment ?? 'other',
    muscles: e.primaryMuscles,
    secondary: e.secondaryMuscles,
    loadType: loadType(e),
    unilateral: UNILATERAL.test(e.name),
    images: e.images,
    instructions: e.instructions,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/exercises.json', JSON.stringify(out));
console.log(out.length, 'exercises;', out.filter((e) => e.unilateral).length, 'unilateral;',
  Object.entries(out.reduce((a, e) => ((a[e.loadType] = (a[e.loadType] || 0) + 1), a), {})));
