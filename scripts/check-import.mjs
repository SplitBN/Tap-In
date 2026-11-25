// File import checks (runs before every build; Node strips the TS types): the Alpha Progression parsers on a synthetic
// fixture (scripts/fixtures, made-up data), the MyNetDiary row mappers on plain row arrays (what SheetJS returns), and the
// exercise mapping against the bundled library (src/data/exercises.json).
import { readFileSync } from 'node:fs';
import { detectKind, excelSerial, mndFood, mndWeights, parseAlphaCustom, parseAlphaMeasurements, parseAlphaPlans, parseAlphaWorkouts, parseDuration, planBaseName, stableHash } from '../src/lib/importParse.ts';
import { collectRefs, mapExercises, normName } from '../src/lib/importMap.ts';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const lib = JSON.parse(readFileSync(new URL('../src/data/exercises.json', import.meta.url), 'utf8')).map((e) => ({ ...e, createdAt: 0, updatedAt: 0, deletedAt: null }));
const fails = [];
const check = (name, ok, detail = '') => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ''}`); };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- detection ----
const files = { w: fx('alpha-workouts.csv'), p: fx('alpha-plans.csv'), c: fx('alpha-custom.csv'), m: fx('alpha-measurements.csv') };
eq('detect workouts', detectKind('a.csv', files.w), 'alpha-workouts');
eq('detect plans', detectKind('a.csv', files.p), 'alpha-plans');
eq('detect custom', detectKind('a.csv', files.c), 'alpha-custom');
eq('detect measurements', detectKind('a.csv', files.m), 'alpha-measurements');
eq('detect xls magic', detectKind('x.bin', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), 'mnd');
eq('detect junk', detectKind('x.csv', 'hello;world'), 'unknown');

// ---- workouts ----
const ws = parseAlphaWorkouts(files.w);
eq('workout count', ws.length, 4);
const [pull, push, extra, unnamed] = ws;
eq('unnamed workout (Day N repeated)', [unnamed.name, unnamed.day, unnamed.week, unnamed.plan], ['Day 2', 2, 1, 'Test Plan A']);
eq('header parts', [pull.name, pull.day, pull.week, pull.plan, pull.date, pull.time, pull.durationMin], ['Pull', 2, 3, 'Test Plan A', '2030-03-14', '18:05', 66]);
eq('am time', [push.time, push.durationMin], ['07:40', 52]);
eq('standalone', [extra.name, extra.plan, extra.day], ['Extra', null, null]);
eq('exercise without sets dropped', pull.exercises.map((e) => e.name), ['Lat Pulldowns with Close Neutral Grip', 'Pull-Ups with Wide Overhand Grip', 'Face Pulls with Rope', 'Zorbo curls']);
const pu = pull.exercises[1];
eq('superset + dropset parsed', [pu.equipment, pu.reps, pu.superset, pu.drops], ['Bodyweight', [8, 8], 1, 1]);
eq('added load', pu.sets, [{ load: 10, reps: 6, added: true }, { load: 0, reps: 7, added: true }]);
eq('decimal load', pull.exercises[0].sets[1], { load: 62.5, reps: 9, added: false });
eq('rep range', push.exercises[0].reps, [6, 8]);
eq('2 dropsets', push.exercises[1].drops, 2);
eq('durations', [parseDuration('1 hr'), parseDuration('1:06 hr'), parseDuration('51 min'), parseDuration('4:56 hr')], [60, 66, 51, 296]);

// ---- plans ----
const plans = parseAlphaPlans(files.p);
eq('plan count', plans.length, 2);
eq('plan header', [plans[0].name, plans[0].startDate, planBaseName(plans[0].name)], ['Test Plan A · 6 weeks', '2030-03-01', 'Test Plan A']);
eq('plan days', plans[0].days.map((d) => [d.day, d.name, d.items.length]), [[1, 'Push', 2], [2, 'Pull', 3]]);
eq('plan item', plans[0].days[0].items[1], { name: 'Seated Lateral Raises', equipment: 'Dumbbells', sets: 1, reps: [10, 10], drops: 2, superset: null });
eq('plan superset + 0 sets', [plans[0].days[1].items[1].superset, plans[0].days[1].items[2].sets], [1, 0]);

// ---- custom + measurements ----
const custom = parseAlphaCustom(files.c);
eq('custom rows', custom.map((c) => [c.name, c.equipment, c.muscle, c.aux, c.notes]), [['Zorbo curls', 'Cable', 'Biceps', ['Forearms', 'Front delts'], 'Pin 4 · low pulley'], ['Hip thrusts', 'Machine', 'Glutes', ['Hams'], '']]);
eq('measurements', parseAlphaMeasurements(files.m), [{ date: '2030-03-11', time: '08:01', kg: 81.4, source: 'alpha' }, { date: '2029-12-24', time: '21:15', kg: 83, source: 'alpha' }]);

// ---- MyNetDiary rows (as SheetJS returns them with header: 1, raw: true) ----
eq('excel serial', excelSerial(47000), { date: '2028-09-04', time: null });
eq('excel serial time', excelSerial(47000.75), { date: '2028-09-04', time: '18:00' });
const foodRows = [
  ['Food ID', 'Date & Time', 'Meal', 'Name', 'Amount', 'Calories, cals', 'Total Fat, g', 'Total Carbs, g', 'Dietary Fiber, g', 'Protein, g'],
  [1, 47000, 'Breakfast', 'Test oats', '60g', 228.4, 4.1, 39.2, 6, 8.04],
  [2, 47000, 'Snacks', 'Macros', 'serving', 430, null, null, null, null],
  [3, 47001.5, 'Dinner', 'חביתה', '2 egg', 180, 12, 1, '', 13],
  [4, 'bad', 'Lunch', 'Skipped row', '1', 1, 1, 1, 1, 1],
];
const food = mndFood(foodRows);
eq('mnd food count', food.length, 3);
eq('mnd food row', food[0], { date: '2028-09-04', time: null, meal: 'breakfast', name: 'Test oats', amount: '60g', n: { kcal: 228, p: 8, c: 39.2, f: 4.1, fiber: 6 } });
eq('mnd missing nutrients = 0', food[1].n, { kcal: 430, p: 0, c: 0, f: 0, fiber: 0 });
eq('mnd snacks + hebrew + time', [food[1].meal, food[2].name, food[2].time], ['snacks', 'חביתה', '12:00']);
const measRows = [['Date', 'Measurement', 'Value', 'Unit'], [47000, 'Body Weight', 82.2, 'kg'], [47000, 'BMR Calories Formula', 1900, 'cals'], [47002, 'Body Weight', 180, 'lbs']];
eq('mnd weights', mndWeights(measRows).map((w) => [w.date, w.kg]), [['2028-09-04', 82.2], ['2028-09-06', 81.6]]);

// ---- stable ids ----
check('hash stable', stableHash('a', 1) === stableHash('a', 1) && stableHash('a', 1) !== stableHash('a', 2) && stableHash('ab', '') !== stableHash('a', 'b'));
eq('hash length', stableHash('x').length, 26);

// ---- exercise mapping ----
eq('normName plural', [normName('Lat Pulldowns'), normName('Pull-Ups'), normName('Incline Flys'), normName('Bench Presses')], ['lat pulldown', 'pull up', 'incline fly', 'bench press']);
const refs = collectRefs(ws, plans);
const rows = mapExercises(refs, lib, custom);
const row = (n, e) => rows.find((r) => r.name === n && r.equipment === e);
const show = (r) => r && `${r.confidence} → ${r.target.kind}:${r.targetName} (${r.why})`;
const expect = (n, e, conf, target, kind) => {
  const r = row(n, e);
  check(`map ${n} · ${e}`, !!r && r.confidence === conf && r.targetName === target && (!kind || r.target.kind === kind), show(r) ?? 'missing');
};
expect('Bench Press', 'Barbell', 'high', 'Bench Press', 'existing');
expect('Lat Pulldowns with Close Neutral Grip', 'Cable', 'high', 'Lat Pulldown · Close Neutral', 'create');
expect('Pull-Ups with Wide Overhand Grip', 'Bodyweight', 'high', 'Pull-Up · Wide Grip', 'create');
expect('Face Pulls with Rope', 'Cable', 'high', 'Face Pull', 'existing');
expect('Seated Lateral Raises', 'Dumbbells', 'medium', 'Lateral Raise', 'existing');
expect('Kneeling Crunches', 'Cable', 'high', 'Crunch', 'existing');
expect('Triceps Pushdowns with Rope', 'Cable', 'high', 'Triceps Pushdown · Rope', 'create');
expect('Zorbo curls', 'Cable', 'new', 'Zorbo curls', 'create');
expect('Squats', 'Barbell', 'high', 'Squat', 'existing');
const z = row('Zorbo curls', 'Cable');
eq('custom muscles from export', z && [z.target.spec.muscles, z.target.spec.secondary, z.target.spec.mechanic, z.note], [['biceps'], ['forearms', 'shoulders'], 'isolation', 'Pin 4 · low pulley']);
eq('bodyweight flag', row('Pull-Ups with Wide Overhand Grip', 'Bodyweight')?.added, true);
eq('uses counted per workout', row('Bench Press', 'Barbell')?.uses, 1);
eq('uses across workouts', row('Squats', 'Barbell')?.uses, 1);
// more names straight from the mapper (no fixture rows needed)
const one = (name, equipment, added = false) => mapExercises([{ name, equipment, uses: 1, added }], lib)[0];
const exp1 = (name, equipment, conf, target) => { const r = one(name, equipment); check(`map1 ${name} · ${equipment}`, r.confidence === conf && r.targetName === target, show(r)); };
exp1('Butterfly with Wide Grip', 'Machine', 'high', 'Pec Deck · Wide Grip');
exp1('Bench Press with Close Grip', 'Barbell', 'high', 'Close-Grip Bench Press');
exp1('Push-Ups with Close Grip', 'Bodyweight', 'high', 'Close-Grip Push-Up');
exp1('Chin-Ups', 'Bodyweight', 'high', 'Chin-Up');
exp1('Lat Pulldowns with Wide Overhand Grip', 'Cable', 'high', 'Lat Pulldown');
exp1('Bent-Over Rows with Wide Grip', 'Barbell', 'medium', 'Bent-Over Row');
exp1('Reverse Butterfly with Wide Grip', 'Machine', 'high', 'Reverse Fly · Wide Grip');
exp1('Reverse Curls', 'Barbell', 'high', 'Reverse Curl');
exp1('Skull Crushers', 'Cable', 'new', 'Skull Crushers');
exp1('Incline Lateral Raises', 'Dumbbells', 'low', 'Lateral Raise');
exp1('Calf Raises on Leg Press', 'Machine', 'high', 'Leg Press Calf Raise');
exp1('Deadlifts', 'Machine', 'new', 'Deadlifts');
check('variant ids stable', one('Pull-Ups with Wide Overhand Grip', 'Bodyweight').target.id === one('Pull-Ups with Wide Overhand Grip', 'Bodyweight').target.id);
// a second run sees the records the first one created and maps to them
const created = rows.filter((r) => r.target.kind === 'create').map((r) => ({ ...r.target.spec, id: r.target.id, createdAt: 1, updatedAt: 1, deletedAt: null }));
const again = mapExercises(refs, [...lib, ...created], custom);
check('re-run maps to created records', again.every((r) => r.target.kind === 'existing'), again.filter((r) => r.target.kind !== 'existing').map((r) => r.name).join(', '));
check('re-run keeps the same targets', again.every((r, i) => r.target.id === rows[i].target.id));

if (fails.length) { console.error('check-import failed:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`check-import: ok (${ws.length} workouts, ${rows.length} exercises mapped)`);
