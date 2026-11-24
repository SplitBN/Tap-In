// Sets per muscle as two-tone bars: solid = direct sets (the exercise's primary muscles), lighter = indirect sets
// (secondary muscles). The bar length is the fractional total (direct + ½ indirect, the convention in
// lib/workoutStats.ts setsByMuscle), the label gives both raw counts: "8 + 4".
import { titleCase } from '../lib/format';

export interface MuscleVolumeRow { muscle: string; direct: number; indirect: number; fractional: number }

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function MuscleVolume({ rows, label = 'Sets per muscle', max }: { rows: MuscleVolumeRow[]; label?: string; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.fractional));
  const pct = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  if (!rows.length) return null;
  return (
    <div className="mv" role="list" aria-label={label}>
      {rows.map((r) => (
        <div key={r.muscle} className="m-row mv-row" role="listitem"
          aria-label={`${titleCase(r.muscle)}: ${r.direct ? `${n(r.direct)} direct sets` : 'no direct sets'}${r.indirect ? `, ${n(r.indirect)} indirect` : ''}`}>
          <span className="m-name">{titleCase(r.muscle)}</span>
          <span className="m-track" aria-hidden>
            {r.direct > 0 && <span className="m-bar" style={{ width: pct(r.direct) }} />}
            {r.indirect > 0 && <span className="m-bar ind" style={{ left: pct(r.direct), width: pct(r.indirect / 2) }} />}
          </span>
          <span className="m-num num" aria-hidden>{r.direct > 0 && <b>{n(r.direct)}</b>}{r.indirect > 0 && <span className="faint">{r.direct > 0 ? ' ' : ''}+{n(r.indirect)}</span>}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend line for MuscleVolume: what solid / light mean. */
export function MuscleVolumeLegend() {
  return (
    <div className="m-legend" aria-hidden>
      <span><i className="sw-now" />Direct</span>
      <span><i className="sw-now ind" />+ Indirect (½)</span>
    </div>
  );
}

/** Titled block for plan / workout views: sets per muscle from planned items, with the legend and the ½ convention. */
export function MuscleVolumeSection({ rows, title = 'Sets per muscle', note }: { rows: MuscleVolumeRow[]; title?: string; note?: string }) {
  if (!rows.length) return null;
  return (
    <section className="card mv-card" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      {note && <div className="chart-note">{note}</div>}
      <MuscleVolumeLegend />
      <MuscleVolume rows={rows} label={title} />
      <p className="faint chart-foot" style={{ margin: '10px 0 0' }}>Direct = the exercise's main muscles. Indirect = muscles that assist (bench press → front delts, triceps), drawn at ½ a set, a common convention.</p>
    </section>
  );
}
