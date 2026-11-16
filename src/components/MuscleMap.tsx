// Simple front / back body figure with the trained muscles filled in the area colour (primary) or a soft tint
// (secondary). Hand-drawn from basic shapes on a 100 × 200 grid per figure; muscle names are free-exercise-db's.
import type { ReactNode } from 'react';
import { titleCase } from '../lib/format';

type Shape = { m: string; el: (k: string) => ReactNode };
const ell = (m: string, cx: number, cy: number, rx: number, ry: number): Shape => ({ m, el: (k) => <ellipse key={k} cx={cx} cy={cy} rx={rx} ry={ry} /> });
const rect = (m: string, x: number, y: number, w: number, h: number, r: number): Shape => ({ m, el: (k) => <rect key={k} x={x} y={y} width={w} height={h} rx={r} /> });
const path = (m: string, d: string): Shape => ({ m, el: (k) => <path key={k} d={d} /> });
/** shape + its mirror image across the body's centre line (x = 50) */
const pair = (f: (mirror: boolean) => Shape) => [f(false), f(true)];
const mx = (x: number, mirror: boolean, w = 0) => (mirror ? 100 - x - w : x);

const BODY: Shape[] = [ // the silhouette under the muscles, drawn on both figures
  ell('', 50, 15, 9.5, 11.5),
  rect('', 45, 22, 10, 12, 3),
  rect('', 33.5, 31, 33, 62, 11),
  rect('', 34.5, 84, 31, 20, 9),
  ...pair((r) => rect('', mx(19.5, r, 13), 35, 13, 36, 6.5)), // upper arms
  ...pair((r) => rect('', mx(16.5, r, 11), 68, 11, 31, 5.5)), // forearms
  ...pair((r) => ell('', mx(20, r), 102, 4.5, 6)), // hands
  ...pair((r) => rect('', mx(35, r, 14), 96, 14, 52, 7)), // thighs
  ...pair((r) => rect('', mx(37, r, 11), 145, 11, 44, 5.5)), // lower legs
  ...pair((r) => rect('', mx(37, r, 11), 186, 11, 8, 4)), // feet
];

const FRONT: Shape[] = [
  rect('neck', 45, 25, 10, 9, 3),
  path('traps', 'M37 37 L45 30 L55 30 L63 37 Z'),
  ...pair((r) => ell('shoulders', mx(31, r), 42, 8.5, 8)),
  ...pair((r) => rect('chest', mx(37.5, r, 12), 36.5, 12, 17, 5)),
  ...pair((r) => ell('biceps', mx(25.5, r), 60, 5.5, 11)),
  ...pair((r) => ell('forearms', mx(21.5, r), 83, 4.8, 12)),
  rect('abdominals', 40, 55.5, 20, 34, 6),
  ...pair((r) => ell('abductors', mx(36, r), 97, 4.5, 8)),
  ...pair((r) => rect('quadriceps', mx(36, r, 11), 100, 11, 45, 5.5)),
  rect('adductors', 47.5, 100, 5, 28, 2.5),
  ...pair((r) => rect('calves', mx(38, r, 9), 150, 9, 35, 4.5)),
];

const BACK: Shape[] = [
  rect('neck', 45, 25, 10, 6, 3),
  path('traps', 'M50 28 L64 38 L50 58 L36 38 Z'),
  ...pair((r) => ell('shoulders', mx(31, r), 42, 8.5, 8)),
  ...pair((r) => path('lats', r ? 'M63 48 L54 58 L54 78 L61 74 Z' : 'M37 48 L46 58 L46 78 L39 74 Z')),
  rect('middle back', 44.5, 59, 11, 16, 3),
  rect('lower back', 42, 77, 16, 13, 4),
  ...pair((r) => ell('triceps', mx(25.5, r), 60, 5.5, 11)),
  ...pair((r) => ell('forearms', mx(21.5, r), 83, 4.8, 12)),
  ...pair((r) => ell('glutes', mx(43, r), 99, 7.5, 9)),
  ...pair((r) => rect('hamstrings', mx(36, r, 11.5), 109, 11.5, 37, 5.5)),
  ...pair((r) => ell('calves', mx(42.5, r), 163, 5.5, 14)),
];

const FRONT_SET = new Set(FRONT.map((s) => s.m));
const BACK_SET = new Set(BACK.map((s) => s.m));

function Figure({ shapes, fill, x }: { shapes: Shape[]; fill: (m: string) => string; x: number }) {
  return (
    <g transform={`translate(${x} 0)`}>
      <g fill="var(--mm-body)">{BODY.map((s, i) => s.el('b' + i))}</g>
      {shapes.map((s, i) => <g key={i} fill={fill(s.m)}>{s.el(String(i))}</g>)}
    </g>
  );
}

/** view 'auto' shows only the side(s) that have a highlighted muscle (both when none). */
export function MuscleMap({ primary, secondary = [], view = 'both', height = 120, label }: {
  primary: string[]; secondary?: string[]; view?: 'both' | 'front' | 'back' | 'auto'; height?: number; label?: string;
}) {
  const p = new Set(primary.map((m) => m.toLowerCase()));
  const s = new Set(secondary.map((m) => m.toLowerCase()).filter((m) => !p.has(m)));
  const fill = (m: string) => (p.has(m) ? 'var(--mm-on, var(--role, var(--accent)))' : s.has(m) ? 'var(--mm-soft)' : 'var(--mm-base)');
  let sides: ('front' | 'back')[] = view === 'both' ? ['front', 'back'] : view === 'auto' ? [] : [view];
  if (view === 'auto') {
    const all = [...p, ...s];
    if (all.some((m) => FRONT_SET.has(m))) sides.push('front');
    if (all.some((m) => BACK_SET.has(m) && !FRONT_SET.has(m)) || (!sides.length && all.some((m) => BACK_SET.has(m)))) sides.push('back');
    if (!sides.length) sides = ['front', 'back'];
  }
  const w = sides.length * 100 + (sides.length - 1) * 8;
  const name = label ?? (p.size ? `Muscles: ${[...p].map(titleCase).join(', ')}${s.size ? `; also ${[...s].map(titleCase).join(', ')}` : ''}` : 'Muscles');
  return (
    <svg className="muscle-map" viewBox={`0 0 ${w} 200`} height={height} width={(height * w) / 200} role="img" aria-label={name}>
      {sides.map((side, i) => <Figure key={side} shapes={side === 'front' ? FRONT : BACK} fill={fill} x={i * 108} />)}
    </svg>
  );
}

/** Primary / secondary muscle lists for a set of exercises (secondary drops anything already primary). */
export function musclesOf(exs: ({ muscles: string[]; secondary: string[] } | undefined)[]) {
  const primary = [...new Set(exs.flatMap((e) => e?.muscles ?? []))];
  const secondary = [...new Set(exs.flatMap((e) => e?.secondary ?? []))].filter((m) => !primary.includes(m));
  return { primary, secondary };
}
