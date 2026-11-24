// Forgiving search shared by foods and exercises.
// - any language (Hebrew included), accents/niqqud ignored, punctuation ignored
// - word order doesn't matter; each typed word may be a prefix ("chick bre" → chicken breast)
// - typos tolerated (1 edit for 4–6 letters, 2 for 7+), common transliterations aliased
// - ranked by match quality, then boosted by how often (and how recently) you've used the item

/** English spellings people type → one canonical spelling (both sides are mapped). */
const ALIASES: Record<string, string> = {
  hummus: 'humus', houmous: 'humus', tehina: 'tahini', techina: 'tahini', tahina: 'tahini', schnitzel: 'shnitzel',
  labneh: 'labane', labaneh: 'labane', shakshouka: 'shakshuka', felafel: 'falafel', bourekas: 'burekas', borekas: 'burekas',
  kube: 'kubbeh', kubba: 'kubbeh', halvah: 'halva', malawah: 'malawach', jahnun: 'jachnun',
  yoghurt: 'yogurt', yoghourt: 'yogurt', doughnut: 'donut', ketchup: 'catsup', aubergine: 'eggplant', courgette: 'zucchini',
  pullup: 'pullups', chinup: 'chinups', pushup: 'pushups', situp: 'situps', db: 'dumbbell', bb: 'barbell', kb: 'kettlebell',
  tricep: 'triceps', bicep: 'biceps', ab: 'abs',
  // gym shorthand expands to several words
  ohp: 'overhead press', military: 'overhead', rdl: 'romanian deadlift', sldl: 'stifflegged deadlift', bss: 'bulgarian split squat',
  pec: 'chest', delt: 'shoulder', delts: 'shoulders',
};

export function normalize(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/(\p{L})-(\p{L})/gu, '$1$2') // "pull-up" → "pullup"
    .replace(/[^\p{L}\p{N} ]/gu, ' ');
}
export const tokenize = (s: string) => normalize(s).split(/\s+/).filter(Boolean).flatMap((w) => (ALIASES[w] ?? w).split(' '));

/** Damerau-Levenshtein (optimal string alignment) with an early exit above `max`. */
function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

const allowed = (len: number) => (len >= 7 ? 2 : len >= 4 ? 1 : 0);

/** Cost of matching one typed word against an item's tokens (lower is better; Infinity = no match). */
function wordCost(w: string, tokens: string[]) {
  let best = Infinity;
  const max = allowed(w.length);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const pos = i * 0.1; // earlier words in the name matter a little more
    if (t === w) return pos;
    if (t.startsWith(w)) best = Math.min(best, 0.6 + pos);
    else if (w.length >= 3 && t.includes(w)) best = Math.min(best, 1.5 + pos);
    // words typed together: "benchpress" = "bench"+"press"
    const pair = i + 1 < tokens.length ? t + tokens[i + 1] : '';
    if (pair && w.length >= 5 && (pair === w || pair.startsWith(w))) best = Math.min(best, 0.8 + pos);
    // typo pass only when the first letter agrees: typos rarely hit the first letter, and it skips ~95% of the work
    if (max && best > 2 && t[0] === w[0]) {
      // compare against the whole word and prefixes around the typed length, so typos made
      // mid-word still match: "pulup" ~ "pullup(s)", "chiken br" ~ "chicken breast"
      let d = editDistance(w, t, max);
      for (const L of [w.length - 1, w.length, w.length + 1]) if (L > 2 && t.length > L) d = Math.min(d, editDistance(w, t.slice(0, L), max));
      if (pair && w.length >= 6) d = Math.min(d, editDistance(w, pair.slice(0, w.length), max));
      if (d <= max) best = Math.min(best, 2 + d * 1.2 + pos);
    }
  }
  return best;
}

/** Match score for a query against an item's searchable text (lower = better; null = no match). */
export function matchScore(queryWords: string[], tokens: string[], nameLength: number): number | null {
  if (!queryWords.length) return null;
  // forgiving: with 2–3 words one may be missing, with 4+ two may — each miss costs more than any typo
  const allowedMisses = queryWords.length >= 4 ? 2 : queryWords.length >= 2 ? 1 : 0;
  let total = 0; let misses = 0;
  for (const w of queryWords) {
    const c = wordCost(w, tokens);
    if (c === Infinity) { if (++misses > allowedMisses) return null; total += 4; continue; }
    total += c;
  }
  if (misses === queryWords.length) return null;
  return total + nameLength / 60; // prefer shorter, more specific names on ties
}

/** Usage boost: frequent and recent items float up. counts: key → {n uses, last timestamp}. */
export function usageBoost(u: { n: number; last: number } | undefined) {
  if (!u) return 0;
  const days = (Date.now() - u.last) / 86400000;
  return Math.log2(1 + u.n) * 1.1 + (days < 7 ? 1 : days < 30 ? 0.5 : 0);
}

/** Generic ranker. `tokensOf` should be cached by the caller for big lists. */
export function rank<T>(items: T[], query: string, opts: RankOpts<T>): T[] {
  return rankScored(items, query, opts).map((x) => x[1]);
}
export type RankOpts<T> = {
  /** one token list, or several fields (e.g. Hebrew name, English name) scored separately — best field wins */
  tokensOf: (it: T) => string[] | string[][]; nameLength: (it: T) => number; keyOf: (it: T) => string;
  usage?: Map<string, { n: number; last: number }>; bias?: (it: T) => number; limit?: number;
};
/** Like rank, with each item's final score (lower = better), for callers that merge several searches. */
export function rankScored<T>(items: T[], query: string, opts: RankOpts<T>): [number, T][] {
  const words = tokenize(query);
  if (!words.length) return [];
  const out: [number, T][] = [];
  for (const it of items) {
    const t = opts.tokensOf(it);
    let m: number | null = null;
    if (Array.isArray(t[0])) {
      for (const field of t as string[][]) {
        const s = matchScore(words, field, field.join(' ').length);
        if (s != null && (m == null || s < m)) m = s;
      }
    } else m = matchScore(words, t as string[], opts.nameLength(it));
    if (m == null) continue;
    out.push([m + (opts.bias?.(it) ?? 0) - usageBoost(opts.usage?.get(opts.keyOf(it))), it]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, opts.limit ?? 60);
}
