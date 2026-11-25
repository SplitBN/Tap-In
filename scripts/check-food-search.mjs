// Food search regression checks against the bundled databases (runs before every build; Node strips the TS types).
// Real queries from agent chats included: mixed Hebrew + English queries used to return nothing.
import { readFileSync } from 'node:fs';
import { bundledItems, rankFoods, scriptParts } from '../src/lib/foodRank.ts';

const json = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf8'));
const items = bundledItems(json('il.json'), json('foods.json'));
const search = (q, limit = 10) => rankFoods(q, [], items, undefined, limit);
const label = (it) => `${it.key} ${it.name}${it.alt ? ` / ${it.alt}` : ''}`;
const fails = [];
const check = (name, ok, detail = '') => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ''}`); };
/** The top `n` results must include one whose names match every pattern. */
function top(q, n, ...patterns) {
  const r = search(q, n);
  const hit = r.find((it) => patterns.every((re) => (typeof re === 'function' ? re(it) : re.test(`${it.name} ${it.alt ?? ''}`))));
  check(`"${q}" → top ${n} has ${patterns.map(String).join(' + ')}`, !!hit, r.map(label).join(' | ') || 'no results');
  return r;
}

// script split
check('scriptParts mixed', JSON.stringify(scriptParts('cooked white rice אורז לבן מבושל')) === JSON.stringify(['אורז לבן מבושל', 'cooked white rice']));
check('scriptParts Hebrew only', scriptParts('אורז לבן מבושל') === null);
check('scriptParts English only', scriptParts('rice cooked') === null);
check('scriptParts number is not a script', scriptParts('חלב 3%') === null && scriptParts('milk 3%') === null);
check('scriptParts number goes to both halves', JSON.stringify(scriptParts('milk 3% חלב')) === JSON.stringify(['חלב 3%', 'milk 3%']));

// mixed Hebrew + English (returned [] before)
const cooked = (it) => !/uncooked|לא מבושל/i.test(`${it.name} ${it.alt ?? ''}`);
top('cooked white rice אורז לבן מבושל', 1, /אורז/, /rice/i, /cooked/i, cooked);
top('roasted chicken thigh skin עוף ירך צלוי', 5, /עוף|chicken/i, /ירך|thigh/i);
top('chocolate chip cookie עוגיית שוקולד ציפס', 1, /עוגי/, /cookie/i, /שוקולד/); // the both-language entry, not a USDA dry mix
top('olive oil שמן זית', 1, /שמן זית/, /olive/i);
top('milk 3% חלב', 3, /חלב/, /3%/);

// single-script behaviour unchanged
top('אורז לבן מבושל', 1, /אורז/, /מבושל/, cooked); // "מבושל" must not match "לא מבושל" first
top('אורז לבן לא מבושל', 1, /אורז/, (it) => /uncooked|לא מבושל/i.test(`${it.name} ${it.alt ?? ''}`));
top('rice cooked', 3, /rice|אורז/i, /cooked|מבושל/i, cooked);
const milk = top('milk', 5, /milk|חלב/i);
check('"milk" does not start with an odd variant', !/human|infant|goat|sheep|camel|חלב אם/i.test(`${milk[0]?.name} ${milk[0]?.alt ?? ''}`), milk[0] && label(milk[0]));
top('banana', 3, /banana|בננה/i);
check('"rice flour" is not plain rice first', /flour|קמח/i.test(`${search('rice flour', 1)[0]?.name} ${search('rice flour', 1)[0]?.alt ?? ''}`), label(search('rice flour', 1)[0] ?? { key: '-', name: 'none' }));

if (fails.length) { console.error(`check-food-search: ${fails.length} failed\n  ${fails.join('\n  ')}`); process.exit(1); }
console.log('check-food-search: ok');
