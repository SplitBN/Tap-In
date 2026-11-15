// Builds src/data/foods.json from USDA FoodData Central "SR Legacy" (public domain, CC0).
// Source: https://fdc.nal.usda.gov/download-datasets  (FoodData_Central_sr_legacy_food_csv_2018-04.zip)
// Usage: node scripts/build-foods.mjs <path-to-unzipped-sr-legacy-folder>
// Output rows (compact): [fdcId, name, categoryIndex, kcal, protein, carbs, fat, fiber, [[portionLabel, grams], ...]]
// All nutrient values are per 100 g, as published by USDA.
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('pass the unzipped SR Legacy folder');

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
async function eachRow(file, fn) {
  const rl = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
  let header;
  for await (const line of rl) {
    if (!line) continue;
    const r = parseLine(line);
    if (!header) { header = r; continue; }
    fn(Object.fromEntries(header.map((h, i) => [h, r[i]])));
  }
}

const NUTRIENT = { 1008: 'kcal', 1003: 'p', 1005: 'c', 1004: 'f', 1079: 'fiber' };
const foods = new Map();
const cats = new Map();
await eachRow('food_category.csv', (r) => cats.set(r.id, r.description));
await eachRow('food.csv', (r) => foods.set(r.fdc_id, { id: +r.fdc_id, name: r.description, cat: r.food_category_id, n: {}, portions: [] }));
await eachRow('food_nutrient.csv', (r) => {
  const k = NUTRIENT[r.nutrient_id]; const f = foods.get(r.fdc_id);
  if (k && f) f.n[k] = +r.amount;
});
const units = new Map();
await eachRow('measure_unit.csv', (r) => units.set(r.id, r.name));
await eachRow('food_portion.csv', (r) => {
  const f = foods.get(r.fdc_id); const g = +r.gram_weight;
  if (!f || !(g > 0)) return;
  const unit = r.measure_unit_id === '9999' ? '' : units.get(r.measure_unit_id) ?? '';
  const amt = r.amount && r.amount !== '0' ? r.amount : '1';
  const label = [amt, unit, r.modifier || r.portion_description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (label && !f.portions.some((p) => p[0] === label)) f.portions.push([label.slice(0, 48), Math.round(g * 10) / 10]);
});

const catList = [...cats.values()];
const catIndex = new Map([...cats.keys()].map((k, i) => [k, i]));
const r1 = (v) => (v == null ? 0 : Math.round(v * 10) / 10);
const rows = [...foods.values()]
  .filter((f) => f.n.kcal != null)
  .map((f) => [f.id, f.name, catIndex.get(f.cat) ?? -1, r1(f.n.kcal), r1(f.n.p), r1(f.n.c), r1(f.n.f), r1(f.n.fiber), f.portions.slice(0, 6)]);

mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/foods.json', JSON.stringify({ source: 'USDA FoodData Central, SR Legacy (April 2018), public domain', categories: catList, rows }));
console.log(rows.length, 'foods;', (readFileSync('src/data/foods.json').length / 1024 / 1024).toFixed(2), 'MB');
