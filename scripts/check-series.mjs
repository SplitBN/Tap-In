// Chart series math checks (runs before every build; Node strips the TS types) on synthetic data:
// e1RM ↔ nRM inversion (incl. the 1–2 reps-to-failure blend), e10RM, weekly bucketing across ISO weeks / year ends,
// gap detection, running-best PR flags, the chart viewport clamp/zoom, the monotone curve (never overshoots) and the
// stamp de-cluttering / label placement rules.
import { e1rm, nRepMax } from '../src/lib/science.ts';
import { DAY_MS, e10rm, gapStarts, isoWeekLabel, localKey, nextWeekStart, runningBest, segments, weekStartMs, weeklyBuckets, clampWindow, zoomWindow, monotoneSegments, monotonePath, monotoneTangents, pickPrStamps, dropOverlaps, clusterByPx } from '../src/lib/series.ts';

const fails = [];
const check = (name, ok, detail = '') => { if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ''}`); };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-6) => check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want}`);
const at = (y, m, d, h = 18) => new Date(y, m - 1, d, h).getTime();

// ---- e1RM ↔ nRM round trip: the load lifted for r reps to failure comes back from its e1RM ----
for (const [w, r, rir] of [[100, 5, 2], [80, 10, 0], [60, 1, 0], [100, 1, 0.5], [100, 1, 1], [42.5, 8, null], [140, 3, 1.5], [20, 15, 0]]) {
  const est = e1rm(w, r, rir);
  near(`round trip ${w}×${r}@${rir}`, nRepMax(est.kg, r + (rir ?? 0)), w, 1e-9);
}
// e10RM = load for 10 reps to failure: a set of exactly 10 reps at 0 RIR → its own load
near('e10RM of a 10-rep max', e10rm(e1rm(75, 10, 0).kg), 75, 1e-9);
near('e10RM ratio', e10rm(100), 100 * (0.488 + 0.538 * Math.exp(-0.75)), 1e-9);
check('e10RM below e1RM', e10rm(100) < 100);
near('nRM n≤1 is the 1RM', nRepMax(100, 1), 100);
// the 1–2 rtf blend is continuous with Wathen(2)
near('blend meets Wathen at 2', nRepMax(100, 1.999999), nRepMax(100, 2), 1e-3);

// ---- weeks ----
eq('week start Monday', localKey(weekStartMs(at(2025, 1, 1))), '2024-12-30'); // Wed Jan 1 2025 → Mon Dec 30 2024
eq('week start on Monday itself', localKey(weekStartMs(at(2025, 3, 3, 0))), '2025-03-03');
eq('Sunday belongs to the week before', localKey(weekStartMs(at(2025, 3, 9, 23))), '2025-03-03');
eq('ISO week 2025-W01 starts Dec 30 2024', isoWeekLabel(at(2024, 12, 30)), '2025-W01');
eq('ISO week 2026-W01 starts Dec 29 2025', isoWeekLabel(at(2025, 12, 31)), '2026-W01');
eq('ISO week 2020-W53', isoWeekLabel(at(2020, 12, 31)), '2020-W53');
eq('ISO week mid-year', isoWeekLabel(at(2025, 6, 15)), '2025-W24');
eq('ISO week 2026-W53 (2026 has 53 weeks)', isoWeekLabel(at(2026, 12, 31)), '2026-W53');
// DST: stepping weeks across the March/October clock changes always lands on a Monday 00:00
{ let ws = weekStartMs(at(2025, 3, 1)); const seen = [];
  for (let i = 0; i < 40; i++) { ws = nextWeekStart(ws); const d = new Date(ws); seen.push(d.getDay() === 1 && d.getHours() === 0); }
  check('nextWeekStart stays on Monday 00:00 across DST', seen.every(Boolean)); }

// sessions on Sun Dec 28 2025, Mon Dec 29 2025, Fri Jan 2 2026, then a 2-week break, Wed Jan 21 2026
const rows = [
  { t: at(2025, 12, 28), volumeKg: 1000, hardSets: 3, totalReps: 24 },
  { t: at(2025, 12, 29), volumeKg: 500, hardSets: 2, totalReps: 16 },
  { t: at(2026, 1, 2), volumeKg: 700, hardSets: 3, totalReps: 20 },
  { t: at(2026, 1, 21), volumeKg: 900, hardSets: 4, totalReps: 30 },
];
const wk = weeklyBuckets(rows, undefined, at(2026, 1, 22));
eq('weekly keys', wk.map((w) => w.weekStart), ['2025-12-22', '2025-12-29', '2026-01-05', '2026-01-12', '2026-01-19']);
eq('weekly iso labels', wk.map((w) => w.isoWeek), ['2025-W52', '2026-W01', '2026-W02', '2026-W03', '2026-W04']);
eq('weekly volume across the year end', wk.map((w) => w.volumeKg), [1000, 1200, 0, 0, 900]);
eq('weekly sets summed per session', wk.map((w) => w.hardSets), [3, 5, 0, 0, 4]);
eq('weekly sessions', wk.map((w) => w.sessions), [1, 2, 0, 0, 1]);
eq('current week flagged', wk.map((w) => w.inProgress), [false, false, false, false, true]);
eq('weekly filled to until', weeklyBuckets(rows.slice(0, 1), at(2026, 1, 6), at(2030, 1, 1)).length, 3);
eq('weekly empty', weeklyBuckets([]), []);
// input order doesn't matter
eq('weekly unsorted input', weeklyBuckets([...rows].reverse(), undefined, at(2026, 1, 22)).map((w) => w.volumeKg), [1000, 1200, 0, 0, 900]);

// ---- gaps ----
const ts = [at(2024, 1, 1), at(2024, 1, 8), at(2024, 2, 18), at(2024, 6, 1), at(2024, 6, 3)];
eq('gap starts (42 d)', gapStarts(ts), [false, false, false, true, false]); // Jan 8 → Feb 18 is 41 days: kept
eq('gap starts (30 d)', gapStarts(ts, 30), [false, false, true, true, false]);
eq('exactly 42 days is not a gap', gapStarts([0, 42 * DAY_MS]), [false, false]);
eq('segments', segments(ts.map((t) => ({ t }))).map((s) => s.length), [3, 2]);
eq('segments empty', segments([]), []);

// ---- running best (volume PRs) ----
eq('running best', runningBest([100, 90, 120, null, 120, 130]), [false, false, true, false, false, true]);
eq('running best first never PR', runningBest([null, 50]), [false, false]);

// ---- viewport ----
const lo = 0, hi = 100 * DAY_MS;
eq('clamp keeps width inside', clampWindow(-10 * DAY_MS, 20 * DAY_MS, lo, hi), [0, 30 * DAY_MS]);
eq('clamp right edge', clampWindow(90 * DAY_MS, 120 * DAY_MS, lo, hi), [70 * DAY_MS, 100 * DAY_MS]);
eq('clamp wider than data', clampWindow(-1, hi + 1, lo, hi), [lo, hi]);
eq('clamp min span', clampWindow(10 * DAY_MS, 11 * DAY_MS, lo, hi), [10 * DAY_MS, 17 * DAY_MS]);
{ const [a, b] = zoomWindow(0, 100 * DAY_MS, 0.5, 50 * DAY_MS, lo, hi); near('zoom around anchor', a, 25 * DAY_MS); near('zoom width', b - a, 50 * DAY_MS); }
{ const [a, b] = zoomWindow(25 * DAY_MS, 75 * DAY_MS, 4, 50 * DAY_MS, lo, hi); eq('zoom out caps at data', [a, b], [lo, hi]); }

// ---- monotone curve: passes through every point and never leaves the y range of its two neighbours ----
{ let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sets = [
    [[0, 10], [10, 10], [20, 50], [30, 48], [40, 120], [41, 0], [60, 60]],
    [[0, 0], [1, 100], [2, 0], [3, 100]],
    [[0, 5], [5, 5], [10, 5]],
    [[0, 1], [100, 2], [101, 50], [300, 49]],
  ];
  for (let k = 0; k < 40; k++) { let x = 0; sets.push(Array.from({ length: 3 + Math.floor(rnd() * 30) }, () => [(x += 0.5 + rnd() * 40), Math.round(rnd() * 200)])); }
  let worst = 0, through = true;
  for (const p of sets) {
    const segs = monotoneSegments(p);
    segs.forEach((s, i) => {
      if (s.a !== p[i] || s.b !== p[i + 1]) through = false;
      const lo = Math.min(s.a[1], s.b[1]), hi = Math.max(s.a[1], s.b[1]);
      for (let u = 0; u <= 1; u += 0.02) {
        const w = 1 - u, y = w * w * w * s.a[1] + 3 * w * w * u * s.c1[1] + 3 * w * u * u * s.c2[1] + u * u * u * s.b[1];
        const x = w * w * w * s.a[0] + 3 * w * w * u * s.c1[0] + 3 * w * u * u * s.c2[0] + u * u * u * s.b[0];
        worst = Math.max(worst, lo - y, y - hi);
        if (x < s.a[0] - 1e-9 || x > s.b[0] + 1e-9) worst = Math.max(worst, 1); // x stays between the points too
      }
    });
  }
  check('monotone curve never overshoots its neighbours', worst <= 1e-9, `overshoot ${worst}`);
  check('monotone curve passes through the points', through);
  eq('flat tangent at a local peak', monotoneTangents([0, 1, 2], [0, 10, 0])[1], 0);
  eq('monotone path 2 points is a straight line', monotonePath([[0, 0], [10, 5]]), 'M0,0L10,5');
  check('monotone path uses curves for 3+ points', /C/.test(monotonePath([[0, 0], [10, 5], [20, 3]])));
  eq('monotone path empty', monotonePath([]), '');
}

// ---- PR stamps: highest kept, then newest, never closer than the gap, capped ----
{ const c = [{ i: 0, x: 10, v: 100 }, { i: 3, x: 40, v: 105 }, { i: 5, x: 60, v: 130 }, { i: 7, x: 120, v: 110 }, { i: 8, x: 130, v: 120 }, { i: 9, x: 200, v: 125 }];
  const k = pickPrStamps(c, 3, 30);
  check('PR stamps keep the highest', k.includes(5), JSON.stringify(k));
  check('PR stamps keep the newest', k.includes(9), JSON.stringify(k));
  check('PR stamps capped', k.length <= 3);
  const xs = k.map((i) => c.find((q) => q.i === i).x).sort((a, b) => a - b);
  check('PR stamps spaced', xs.every((x, j) => !j || x - xs[j - 1] >= 30), JSON.stringify(xs));
  eq('PR stamps none', pickPrStamps([], 3, 30), []);
  eq('PR stamps single', pickPrStamps([{ i: 2, x: 5, v: 1 }], 3, 30), [2]);
  // a dense run of 200 PRs (a beginner's first months) still gives at most max, all spaced
  const many = Array.from({ length: 200 }, (_, i) => ({ i, x: i * 1.5, v: i }));
  const km = pickPrStamps(many, 4, 36);
  check('PR stamps dense: capped and spaced', km.length <= 4 && km.every((i, j) => !j || many[i].x - many[km[j - 1]].x >= 36), JSON.stringify(km));
}

// ---- label placement + event clustering ----
eq('drop overlaps by priority', dropOverlaps([{ x: 0, y: 0, w: 20, h: 10 }, { x: 10, y: 5, w: 20, h: 10 }, { x: 40, y: 0, w: 10, h: 10 }]), [0, 2]);
eq('drop overlaps keeps separate', dropOverlaps([{ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 20, w: 10, h: 10 }]), [0, 1]);
eq('cluster by px', clusterByPx([100, 10, 25, 300, 110], 20), [[1, 2], [0, 4], [3]]);
eq('cluster empty', clusterByPx([], 20), []);

if (fails.length) { console.error(`check-series: ${fails.length} failed\n  ` + fails.join('\n  ')); process.exit(1); }
console.log('check-series: ok');
