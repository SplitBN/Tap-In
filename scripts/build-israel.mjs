// Builds src/data/il.json — Israeli foods, bundled for offline search:
//  1. Tzameret, Israel Ministry of Health national nutrition database (data.gov.il dataset
//     "nutrition-database", open licence): generic foods & dishes, Hebrew + English names, per 100 g,
//     with household measures. Fetched via the data.gov.il datastore API (resource ids below).
//  2. Open Food Facts products sold in Israel (countries_tags_en=israel), ODbL: packaged products
//     with barcodes, per 100 g as labelled.
// Usage: node scripts/build-israel.mjs <tzameret-dir with foods.json/units.json/food_units.json> <off-dir with p*.json>
//   Tzameret: datastore_search?resource_id=c3cb0630-0650-46c1-a068-82d575c094b2 (foods),
//             98fb46fe-e8de-4067-94d2-b0a8ea4269da (units), 755d28c0-75f7-40e1-9c8c-ecdd106f9b2d (food→unit weights)
//   OFF:      https://world.openfoodfacts.org/api/v2/search?countries_tags_en=israel&page_size=1000&page=N
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [tzDir, offDir] = process.argv.slice(2);
if (!tzDir || !offDir) throw new Error('usage: build-israel.mjs <tzameret-dir> <off-dir>');
const recs = (f) => JSON.parse(readFileSync(join(tzDir, f), 'utf8')).result.records;
const r1 = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };

// ---- Tzameret ----
const unitName = new Map(recs('units.json').map((u) => [String(u.smlmida), String(u.shmmida).replace(/\s+/g, ' ').trim()]));
const SKIP_UNITS = new Set(['700', '2000']); // gram / kilogram: we already offer grams
const portionsByFood = new Map();
for (const fu of recs('food_units.json')) {
  if (SKIP_UNITS.has(String(fu.mida))) continue;
  const g = r1(fu.mishkal); const label = unitName.get(String(fu.mida));
  if (!g || !label) continue;
  const list = portionsByFood.get(String(fu.mmitzrach)) ?? [];
  if (!list.some((p) => p[0] === label)) list.push([`1 ${label}`.slice(0, 40), g]);
  portionsByFood.set(String(fu.mmitzrach), list);
}
const moh = [];
for (const f of recs('foods.json')) {
  const kcal = r1(f.food_energy);
  if (kcal == null || !f.shmmitzrach || /^FFQ/i.test(String(f.shmmitzrach))) continue; // FFQ rows are survey groupings, not foods
  moh.push([f.Code, String(f.shmmitzrach).trim(), String(f.english_name ?? '').trim(), kcal, r1(f.protein) ?? 0, r1(f.carbohydrates) ?? 0,
    r1(f.total_fat) ?? 0, r1(f.total_dietary_fiber) ?? 0, (portionsByFood.get(String(f.Code)) ?? []).slice(0, 6)]);
}

// ---- Open Food Facts (Israel) ----
const seen = new Set(); const off = []; const names = new Map(); // barcode → [name, brand] for products without full nutrition
for (const file of readdirSync(offDir).filter((f) => /^p\d+\.json$/.test(f))) {
  let page; try { page = JSON.parse(readFileSync(join(offDir, file), 'utf8')); } catch { continue; }
  for (const p of page.products ?? []) {
    const code = String(p.code ?? '').trim();
    if (!/^\d{8,14}$/.test(code) || seen.has(code)) continue;
    const n = p.nutriments ?? {};
    const kj = r1(n['energy_100g']);
    const kcal = r1(n['energy-kcal_100g']) ?? (kj != null ? Math.round(kj / 4.184) : null);
    const pr = r1(n['proteins_100g']), c = r1(n['carbohydrates_100g']), fat = r1(n['fat_100g']);
    const he = String(p.product_name_he ?? '').trim(); const en = String(p.product_name_en ?? p.product_name ?? '').trim();
    const name = he || en;
    if (!name) continue;
    if (kcal == null || pr == null || c == null || fat == null || kcal > 950) { names.set(code, [name, String(p.brands ?? '').split(',')[0].trim()]); continue; } // incomplete: keep name for scan prefill
    seen.add(code);
    const brand = String(p.brands ?? '').split(',')[0].trim();
    off.push([code, name, he && en && en !== he ? en : '', brand, kcal, pr, c, fat, r1(n['fiber_100g']) ?? 0, r1(p.serving_quantity) ?? 0]);
  }
}

writeFileSync('src/data/il.json', JSON.stringify({
  sources: {
    moh: 'Israel Ministry of Health, Tzameret national nutrition database (data.gov.il, open licence)',
    off: 'Open Food Facts contributors, products sold in Israel (ODbL)',
  },
  moh, off,
  names: [...names].filter(([code]) => !seen.has(code)).map(([code, [n, br]]) => [code, n, br]),
}));
console.log(`${moh.length} Tzameret foods, ${off.length} Israeli products (+${names.size} name-only), ${(readFileSync('src/data/il.json').length / 1024 / 1024).toFixed(2)} MB`);
