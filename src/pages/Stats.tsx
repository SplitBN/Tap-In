import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { BarChart, type Bar } from '../components/Charts';
import { Icon } from '../components/Icon';
import { useSettings } from '../db/settings';
import { titleCase, plural } from '../lib/format';
import { keyToDate } from '../lib/nutrition';
import { fromKg } from '../lib/science';
import { run } from '../api/registry';
import { progressWeekly, type WeeklyProgress } from '../api/progress';

const RANGES = [{ weeks: 12, label: '12W' }, { weeks: 26, label: '6M' }, { weeks: 52, label: '1Y' }];
const wk = (key: string) => keyToDate(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)} min`);

/** Training over time: weekly volume, workouts, time and PRs, plus hard sets per muscle this week. */
export function StatsPage() {
  const nav = useNavigate();
  const { unit } = useSettings();
  const [weeks, setWeeks] = useState(12);
  const data = useLiveQuery(() => run(progressWeekly, { weeks }), [weeks]);
  if (!data) return null;
  const W = data.weeks;
  const bars = (v: (w: WeeklyProgress['weeks'][number]) => number, cap?: (w: WeeklyProgress['weeks'][number]) => string): Bar[] =>
    W.map((w) => ({ key: w.weekStart, label: wk(w.weekStart), v: v(w), partial: w.inProgress, caption: `Week of ${wk(w.weekStart)}${cap ? ` · ${cap(w)}` : ''}` }));
  const t = data.totals;
  const vol = (kg: number) => Math.round(fromKg(kg, unit));
  const none = t.workouts === 0;

  return (
    <div className="page wide" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" /></button>
        <h1 className="small">Stats</h1>
        <button className="icon-btn" aria-label="History" onClick={() => nav('/history')}><Icon name="history" size={20} /></button>
      </header>

      <div className="seg range-seg" role="group" aria-label="Time range" style={{ marginBottom: 14 }}>
        {RANGES.map((r) => <button key={r.weeks} aria-pressed={weeks === r.weeks} onClick={() => setWeeks(r.weeks)}>{r.label}</button>)}
      </div>

      <div className="stat-tiles">
        <Tile label="Workouts" value={String(t.workouts)} sub={`${W.at(-1)!.workouts} this week`} />
        <Tile label="Avg workout" value={t.avgMinutes != null ? fmtMin(t.avgMinutes) : '–'} sub={`${fmtMin(t.minutes)} total`} />
        <Tile label="Volume" value={`${vol(t.volumeKg).toLocaleString()} ${unit}`} sub={`${t.workingSets} sets`} />
        <Tile label="PRs" value={String(t.prs)} sub="e1RM, weight, reps" />
      </div>

      {none ? (
        <div className="empty"><Icon name="chart" size={40} /><h3>No workouts in this range</h3><p>Finish a workout and your weeks show up here.</p></div>
      ) : (
        <>
          <div className="chart-grid">
            <ChartCard title="Weekly volume" note="Load × reps of working sets and drops, warm-ups excluded">
              <BarChart label="Weekly volume" bars={bars((w) => vol(w.volumeKg), (w) => `${w.workingSets} sets`)} fmt={(v) => `${v.toLocaleString()} ${unit}`} />
            </ChartCard>
            <ChartCard title="Workouts per week">
              <BarChart integer label="Workouts per week" bars={bars((w) => w.workouts, (w) => (w.avgMinutes != null ? `avg ${fmtMin(w.avgMinutes)}` : 'rest week'))} fmt={(v) => `${plural(v, 'workout', 'workouts')}`} />
            </ChartCard>
            <ChartCard title="Time per week" note="Total workout time (start to finish)">
              <BarChart label="Workout time per week" bars={bars((w) => w.minutes, (w) => `${plural(w.workouts, 'workout', 'workouts')}`)} fmt={fmtMin} />
            </ChartCard>
            <ChartCard title="PRs per week" note="Each e1RM, weight or rep PR counts 1">
              <BarChart integer label="PRs per week" bars={bars((w) => w.prs)} fmt={(v) => `${plural(v, 'PR', 'PRs')}`} />
            </ChartCard>
          </div>
          <Muscles data={data} />
          <details className="card stats-table">
            <summary>Table</summary>
            <div className="table-scroll">
              <table className="num">
                <thead><tr><th scope="col">Week of</th><th scope="col">Workouts</th><th scope="col">Time</th><th scope="col">Sets</th><th scope="col">Volume ({unit})</th><th scope="col">PRs</th></tr></thead>
                <tbody>
                  {[...W].reverse().map((w) => (
                    <tr key={w.weekStart}><th scope="row">{wk(w.weekStart)}{w.inProgress ? ' (now)' : ''}</th><td>{w.workouts}</td><td>{w.minutes ? fmtMin(w.minutes) : '–'}</td><td>{w.workingSets}</td><td>{vol(w.volumeKg).toLocaleString()}</td><td>{w.prs}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="stat-tile"><span className="rec-label">{label}</span><b>{value}</b><span className="rec-meta">{sub}</span></div>;
}

function ChartCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="card chart-card" aria-label={title}>
      <h3 className="chart-title">{title}</h3>
      {note && <div className="chart-note">{note}</div>}
      {children}
    </section>
  );
}

/** This week's hard sets per muscle (bar) against the average of earlier full weeks (tick), with the 10-set context line. */
function Muscles({ data }: { data: WeeklyProgress }) {
  const ref = data.reference.setsPerWeek;
  const rows = data.muscles.filter((m) => m.thisWeek.direct > 0 || (m.average.direct ?? 0) > 0);
  const max = Math.max(ref + 2, ...rows.map((m) => Math.max(m.thisWeek.direct, m.average.direct ?? 0)));
  const pct = (v: number) => `${(v / max) * 100}%`;
  const avgN = data.weeksAveraged;
  return (
    <section className="card muscle-card" aria-label="Hard sets per muscle this week">
      <h3 className="chart-title">Hard sets per muscle</h3>
      <div className="chart-note">This week so far{avgN ? ` vs average of the last ${plural(avgN, 'full week', 'full weeks')}` : ''}</div>
      <div className="m-legend" aria-hidden>
        <span><i className="sw-now" />This week</span>
        {avgN > 0 && <span><i className="sw-avg" />Average</span>}
        <span><i className="sw-ref" />{ref} sets</span>
      </div>
      {rows.length ? (
        <div className="m-rows" role="list">
          {rows.map((m) => (
            <div key={m.muscle} className="m-row" role="listitem"
              aria-label={`${titleCase(m.muscle)}: ${m.thisWeek.direct} sets this week${m.average.direct != null ? `, average ${m.average.direct}` : ''}`}>
              <span className="m-name">{titleCase(m.muscle)}</span>
              <span className="m-track">
                <span className="m-ref" style={{ left: pct(ref) }} />
                {m.thisWeek.direct > 0 && <span className="m-bar" style={{ width: pct(m.thisWeek.direct) }} />}
                {m.average.direct != null && m.average.direct > 0 && <span className="m-avg" style={{ left: pct(m.average.direct) }} />}
              </span>
              <span className="m-num num"><b>{m.thisWeek.direct}</b>{m.average.direct != null && <span className="faint"> / {m.average.direct}</span>}</span>
            </div>
          ))}
        </div>
      ) : <p className="muted" style={{ margin: '8px 0 0' }}>No sets logged yet.</p>}
      <p className="faint chart-foot" style={{ margin: '12px 0 0' }}>
        Working sets for each exercise's main muscles (warm-ups excluded, a left + right pair is one set). Schoenfeld, Ogborn &amp; Krieger 2017 found more weekly sets per muscle gave more growth; {ref}+ sets was the highest group they studied. The line is context, not a target or a limit.
      </p>
    </section>
  );
}
