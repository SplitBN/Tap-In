// Evidence library: a curated, citation-checked set of research findings (src/data/evidence.json — meta-analyses,
// position stands, key RCTs) the assistant searches before giving training / nutrition / supplement advice.
// Small BM25 over tags, question, topic, finding and practical; loaded lazily so it stays out of the main bundle.
import { z } from 'zod';
import { defineCommand } from './registry';

export type Citation = { authors: string; year: number; title: string; journal: string; doi?: string; pmid?: string; url: string };
export type Evidence = {
  id: string; topic: string; tags: string[]; question: string; finding: string;
  certainty: 'high' | 'moderate' | 'low'; evidenceType: 'meta-analysis' | 'systematic review' | 'RCT' | 'position stand' | 'observational' | 'consensus';
  population: string; practical: string; citations: Citation[];
};

// query words → extra words that mean the same here (both directions are not needed: entries carry rich tags)
const SYN: Record<string, string[]> = {
  rir: ['reps in reserve', 'failure', 'rpe'], rpe: ['rir', 'exertion'], failure: ['rir', 'proximity'],
  cut: ['deficit', 'cutting', 'weight loss'], cutting: ['deficit', 'cut'], diet: ['deficit'], bulk: ['surplus', 'bulking'], bulking: ['surplus'],
  lose: ['loss', 'deficit'], losing: ['loss', 'deficit'], fat: ['fat loss'], weight: ['bodyweight'], scale: ['weight', 'fluctuation'],
  muscle: ['hypertrophy', 'lean mass'], grow: ['hypertrophy'], growth: ['hypertrophy'], gains: ['hypertrophy', 'strength'], size: ['hypertrophy'],
  stronger: ['strength'], max: ['1rm'], '1rm': ['e1rm', 'max', 'one rep max'], e1rm: ['1rm'],
  sets: ['volume'], volume: ['sets'], often: ['frequency'], split: ['frequency'], reps: ['rep range', 'load'], heavy: ['load'], light: ['load'],
  rest: ['rest interval', 'between sets'], cardio: ['aerobic', 'concurrent'], aerobic: ['cardio'], running: ['cardio', 'concurrent'], walking: ['steps'],
  whey: ['protein powder', 'protein'], shake: ['protein powder'], calories: ['energy', 'tdee', 'maintenance'], kcal: ['energy', 'calories'],
  maintenance: ['tdee'], metabolism: ['metabolic adaptation', 'tdee'], water: ['water weight', 'glycogen'], bloating: ['water retention', 'water weight'],
  fish: ['omega-3'], d: ['vitamin d'], booster: ['testosterone booster'], preworkout: ['caffeine', 'pre-workout'], coffee: ['caffeine'],
  // a few Hebrew words (the user writes Hebrew; the library is English)
  'קריאטין': ['creatine'], 'חלבון': ['protein'], 'קפאין': ['caffeine'], 'מנוחה': ['rest'], 'סטים': ['sets', 'volume'], 'שינה': ['sleep'],
  'קרדיו': ['cardio'], 'גרעון': ['deficit'], 'חיטוב': ['deficit', 'cut'], 'מסה': ['surplus', 'bulk'], 'משקל': ['weight'], 'שומן': ['fat'], 'שריר': ['hypertrophy', 'muscle'],
  break: ['detraining', 'deload'], vacation: ['detraining'], tired: ['sleep', 'fatigue'], drinking: ['alcohol'], beer: ['alcohol'],
};
const STOP = new Set('a an and are as at be by do does for from how i in is it my of on or should the to what when which why with you your much many can me per vs'.split(' '));
const stem = (w: string) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const SYN_STEMMED = new Map(Object.entries(SYN).map(([k, v]) => [stem(k), v])); // query tokens are stemmed ("sets" → "set")
const tokens = (s: string) => (s.toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [])
  .flatMap((w) => (w.includes('-') ? [w, ...w.split('-')] : [w])).filter((w) => !STOP.has(w)).map(stem);

const FIELDS: [keyof Evidence, number][] = [['tags', 3], ['question', 2.5], ['topic', 2], ['finding', 1], ['practical', 0.6]];
type Index = { list: Evidence[]; docs: Map<string, number>[]; avg: number[]; df: Map<string, number> };
let index: Promise<Index> | null = null;
function load(): Promise<Index> {
  index ??= import('../data/evidence.json').then(({ default: raw }) => {
    const list = raw as Evidence[];
    const lens = FIELDS.map(() => 0);
    const df = new Map<string, number>();
    const docs = list.map((e) => {
      const tf = new Map<string, number>(); // key "field|token" → count
      const seen = new Set<string>();
      FIELDS.forEach(([f], fi) => {
        const ts = tokens(f === 'tags' ? (e.tags).join(' ') : String(e[f]));
        lens[fi] += ts.length;
        tf.set(`#${fi}`, ts.length);
        for (const t of ts) { tf.set(`${fi}|${t}`, (tf.get(`${fi}|${t}`) ?? 0) + 1); seen.add(t); }
      });
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
      return tf;
    });
    return { list, docs, avg: lens.map((l) => l / Math.max(1, list.length)), df };
  });
  return index;
}

/** BM25F-style score per entry. Phrase bonus when the whole query appears in tags/question. */
async function search(query: string, topic?: string) {
  const ix = await load();
  const q = tokens(query);
  const terms = new Map<string, number>(); // token → query weight (synonyms count half)
  for (const t of q) terms.set(t, 1);
  for (const t of q) for (const s of SYN_STEMMED.get(t) ?? []) for (const st of tokens(s)) if (!terms.has(st)) terms.set(st, 0.5);
  const N = ix.list.length, k1 = 1.2, b = 0.75, phrase = query.toLowerCase().trim();
  return ix.list.map((e, i) => {
    if (topic && e.topic !== topic) return { e, score: 0 };
    const tf = ix.docs[i];
    let score = 0;
    for (const [t, w] of terms) {
      const n = ix.df.get(t);
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      let wtf = 0;
      FIELDS.forEach(([, boost], fi) => { const c = tf.get(`${fi}|${t}`); if (c) wtf += (boost * c) / (1 - b + (b * (tf.get(`#${fi}`) ?? 0)) / (ix.avg[fi] || 1)); });
      score += w * idf * ((wtf * (k1 + 1)) / (wtf + k1));
    }
    if (phrase.length > 3 && (e.tags.includes(phrase) || e.question.toLowerCase().includes(phrase))) score *= 1.3;
    return { e, score };
  }).filter((r) => r.score > 0).sort((a, b2) => b2.score - a.score);
}

const short = (c: Citation) => `${c.authors.split(/[ ,]/)[0]} ${c.year}, ${c.journal}`;

export const evidenceSearch = defineCommand({ name: 'evidence.search', kind: 'query',
  description: 'Search the curated research library (meta-analyses, position stands, key RCTs; every citation checked) for training, nutrition, supplement and body-weight questions. Check it before giving such advice and cite the short refs it returns. Returns up to k (default 3) entries: id, question, finding (numbers), practical, certainty, type, refs [{cite, url}]; evidence.get(id) gives full citations.',
  input: z.object({ query: z.string().trim().min(2).max(200).describe('Keywords or a question, e.g. "creatine loading", "sets per week hypertrophy"'),
    k: z.number().int().min(1).max(8).optional(), topic: z.string().optional().describe('Filter, e.g. hypertrophy, protein, supplements, energy, cardio') }),
  run: async ({ query, k, topic }) => {
    const all = await search(query, topic);
    const hits = all.filter((r) => r.score >= all[0].score * 0.45).slice(0, k ?? 3); // drop weak tail matches
    if (!hits.length) return { results: [], note: 'Nothing in the library; try other words or web_answer with academic: true.' };
    return { results: hits.map(({ e }) => ({ id: e.id, question: e.question, finding: e.finding, practical: e.practical, certainty: e.certainty, type: e.evidenceType,
      refs: e.citations.map((c) => ({ cite: short(c), url: c.url })) })) };
  } });

export const evidenceGet = defineCommand({ name: 'evidence.get', kind: 'query',
  description: 'One research-library entry by id (from evidence.search) with population and full citations (authors, year, title, journal, DOI, PubMed link).',
  input: z.object({ id: z.string().min(1) }),
  run: async ({ id }) => {
    const e = (await load()).list.find((x) => x.id === id);
    if (!e) throw new Error(`No evidence entry "${id}". Use evidence.search.`);
    return e;
  } });
