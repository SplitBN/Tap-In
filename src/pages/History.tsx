import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ExName, ExerciseThumb } from '../components/ExercisePicker';
import { exerciseLabel } from '../lib/equipment';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { TimeChart, type TPoint } from '../components/TimeChart';
import { useChartEvents } from '../components/chartEvents';
import { ImportHint } from '../components/ImportHint';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import type { LoadType, Unit } from '../db/types';
import { effortText, fmtWeight, plural, relDay, setText } from '../lib/format';
import { dateKey, keyToDate, shiftDate } from '../lib/nutrition';
import { fromKg, RELIABLE_MAX_RTF, rirToRpe } from '../lib/science';
import { run } from '../api/registry';
import { progressExercise, progressExerciseSeries, progressSessions, type ExerciseSeries } from '../api/progress';
import { exercisesFamily } from '../api/gym';
import { groupOf } from '../lib/variants';
import { ExerciseInfo } from './Session';
import { RepeatRows, SaveAsWorkoutSheet, useRepeatWorkout } from '../components/RepeatWorkout';

/** Volume in the display unit, rounded, with thousands separators ("8,450 kg"). */
export const fmtVolume = (kg: number, unit: Unit) => `${Math.round(fromKg(kg, unit)).toLocaleString()} ${unit}`;

export function HistoryPage() {
  const settings = useSettings();
  const nav = useNavigate();
  const rows = useLiveQuery(() => run(progressSessions, { limit: 200 }), []);
  const [menuFor, setMenuFor] = useState<{ id: string; name: string } | null>(null);
  const [saveAs, setSaveAs] = useState<{ id: string; name: string } | null>(null);
  const repeat = useRepeatWorkout();
  return (
    <div className="page" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav('/plans')}><Icon name="chevronLeft" /></button>
        <h1 className="small">History</h1>
        <button className="icon-btn" aria-label="Stats" onClick={() => nav('/stats')}><Icon name="chart" size={20} /></button>
      </header>
      {!rows ? null : rows.length ? (
        <div className="list">
          {rows.map((s) => (
            <div key={s.id} className="list-item hist-row">
            <Link to={`/session/${s.id}`} className="hist-link pressable">
              <span className="grow">
                <span className="title">{s.name}</span>
                <span className="sub num" style={{ display: 'block' }}>
                  {relDay(keyToDate(s.date).getTime())} · {s.minutes} min · {plural(s.workingSets, 'set', 'sets')}{s.volumeKg > 0 ? ` · ${fmtVolume(s.volumeKg, settings.unit)}` : ''}
                </span>
              </span>
              {s.prs > 0 && <span className="badge good num" aria-label={`${plural(s.prs, 'personal record', 'personal records')}`}><Icon name="flag" size={12} /> {s.prs}</span>}
            </Link>
            <button className="icon-btn sm hist-more" aria-label={`${s.name}, ${relDay(keyToDate(s.date).getTime())}: options`} aria-haspopup="dialog" onClick={() => setMenuFor({ id: s.id, name: s.name })}>
              <Icon name="more" size={20} stroke={3} />
            </button>
            </div>
          ))}
        </div>
      ) : <div className="empty"><Icon name="history" size={40} /><h3>No workouts yet</h3><p>Finished workouts land here.</p><Link to="/" className="btn primary"><Icon name="play" size={18} /> Start a workout</Link><ImportHint from="Alpha Progression" /></div>}
      <Sheet open={!!menuFor} onClose={() => setMenuFor(null)} title={menuFor?.name} role="gym">
        {menuFor && (
          <div className="am"><div className="group">
            <button className="am-row pressable" onClick={() => { const id = menuFor.id; setMenuFor(null); nav(`/session/${id}`); }}><Icon name="chart" /><span className="grow">Open</span></button>
            <RepeatRows onRepeat={() => repeat(menuFor.id, () => setMenuFor(null))} onSaveAs={() => { setSaveAs(menuFor); setMenuFor(null); }} />
          </div></div>
        )}
      </Sheet>
      <SaveAsWorkoutSheet open={!!saveAs} sessionId={saveAs?.id ?? ''} sessionName={saveAs?.name ?? ''} onClose={() => setSaveAs(null)} />
    </div>
  );
}

type Range = '3M' | '1Y' | 'All';

/** "100 kg", "BW+10 kg", "BW−20 kg" — the logged load the way the set list shows it. */
function loadText(loadType: LoadType, loadKg: number, unit: Unit) {
  if (loadType === 'weighted') return fmtWeight(loadKg, unit);
  if (loadType === 'bodyweight') return loadKg ? `BW+${fmtWeight(loadKg, unit)}` : 'BW';
  return `BW−${fmtWeight(loadKg, unit)}`;
}
const shortDate = (key: string) => keyToDate(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: key.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' });

/** Per-exercise progress: all-time records, charts over a chosen range, then every session with its sets. */
export function ExerciseHistoryPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const u = settings.unit;
  const ex = useLiveQuery(() => db.exercises.get(id!), [id]);
  const [info, setInfo] = useState(false);
  const [range, setRange] = useState<Range>('All');
  const from = useMemo(() => (range === 'All' ? undefined : shiftDate(dateKey(), range === '3M' ? -91 : -365)), [range]);
  // variants of the same lift: switch between them, or roll them all up into one history
  const fam = useLiveQuery(async () => (ex && groupOf(ex) ? run(exercisesFamily, { exerciseId: ex.id }) : null), [ex?.id, ex?.family]);
  const variants = fam && fam.members.length > 1 ? fam.members : null;
  const [combined, setCombined] = useState(false);
  const data = useLiveQuery(() => run(progressExercise, { exerciseId: id!, from, family: combined && !!variants }), [id, from, combined, !!variants]);
  // keep the selected variant chip in view (horizontal scroll of the chip row only, never the page)
  const chipsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = chipsRef.current; const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && chip && (chip.offsetLeft < row.scrollLeft || chip.offsetLeft + chip.offsetWidth > row.scrollLeft + row.clientWidth)) row.scrollLeft = chip.offsetLeft - 16;
  }, [id, combined, !!variants]);
  const variantName = (exId: string) => { const m = fam?.members.find((x) => x.id === exId); return m ? m.text || 'Standard' : ''; };

  if (!data) return null;
  const lt = data.exercise.loadType;
  // effort in the user's chosen notation; RIR shown as RPE only where the RIR-based scale maps one-to-one (science.ts)
  const effort = (rir: number | null) => { const e = rir == null ? null : effortText({ rir, rpe: rirToRpe(rir) }, settings.effortMode); return e == null ? '' : settings.effortMode === 'rir' ? ` @${e} RIR` : ` @${e}`; };
  const rows = data.sessions;

  const everAdded = data.sessions.some((r) => (r.heaviest?.loadKg ?? 0) > 0) || (data.records.heaviest?.loadKg ?? 0) > 0;

  const rec = data.records;
  const newestFirst = [...rows].reverse();
  return (
    <div className="page wide" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{ex ? <ExName ex={ex} /> : data.exercise.label}</h1>
        {ex && <button className="icon-btn" aria-label="How to do it" onClick={() => setInfo(true)}><Icon name="info" size={20} /></button>}
      </header>

      {variants && (
        <div className="chips" role="group" aria-label="Variants" style={{ marginBottom: 12 }} ref={chipsRef}>
          <button className="chip" aria-pressed={combined} onClick={() => setCombined(true)}><Icon name="layers" size={16} stroke={2.2} />All</button>
          {variants.map((m) => (
            <button key={m.id} className="chip" aria-pressed={!combined && m.id === id}
              onClick={() => { setCombined(false); if (m.id !== id) nav(`/exercise/${m.id}`, { replace: true }); }}>{m.text || 'Standard'}</button>
          ))}
        </div>
      )}
      <div className="row card" style={{ marginBottom: 12 }}>
        <ExerciseThumb ex={ex} size={56} />
        <div className="grow">
          <div className="num w-7 t-20">{plural(data.totalSessions, 'session', 'sessions')}</div>
          <div className="muted" style={{ fontSize: '0.8125rem' }}>{data.firstDate ? `${shortDate(data.firstDate)} – ${shortDate(data.lastDate!)}` : 'Not done yet'}</div>
        </div>
      </div>

      {data.totalSessions > 0 && (
        <>
          <h2 className="section-title">All-time records</h2>
          <div className="card rec-card">
            <div className="rec-grid">
              {rec.bestE1rm && <RecTile label="Est. 1RM" value={`${rec.bestE1rm.lowerBound ? '≥' : rec.bestE1rm.reliable ? '' : '≈'}${fmtWeight(rec.bestE1rm.kg, u)}`}
                sub={`${loadText(lt, rec.bestE1rm.loadKg, u)} × ${rec.bestE1rm.reps} · ${shortDate(rec.bestE1rm.date)}`} to={`/session/${rec.bestE1rm.sessionId}`} />}
              {rec.heaviest && (lt !== 'bodyweight' || everAdded) && <RecTile label={lt === 'assisted' ? 'Least assistance' : lt === 'bodyweight' ? 'Most added' : 'Heaviest'}
                value={lt === 'weighted' ? fmtWeight(rec.heaviest.loadKg, u) : loadText(lt, rec.heaviest.loadKg, u)} sub={`× ${rec.heaviest.reps} · ${shortDate(rec.heaviest.date)}`} to={`/session/${rec.heaviest.sessionId}`} />}
              {rec.mostReps && <RecTile label="Most reps" value={`${rec.mostReps.reps}`} sub={`${loadText(lt, rec.mostReps.loadKg, u)} · ${shortDate(rec.mostReps.date)}`} to={`/session/${rec.mostReps.sessionId}`} />}
              {rec.bestVolume && <RecTile label="Best volume" value={fmtVolume(rec.bestVolume.kg, u)} sub={shortDate(rec.bestVolume.date)} to={`/session/${rec.bestVolume.sessionId}`} />}
            </div>
            {rec.repRecords.length > 1 && (
              <>
                <div className="rec-sub">Rep records</div>
                <div className="rec-reps">
                  {rec.repRecords.slice(0, 6).map((r) => (
                    <Link key={r.loadKg} to={`/session/${r.sessionId}`} className="rec-rep pressable">
                      <span className="num">{loadText(lt, r.loadKg, u)}</span><b className="num">× {r.reps}</b><span className="faint">{shortDate(r.date)}</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>

          <h2 className="section-title" style={{ marginTop: 22 }}>Progress</h2>
          <ExerciseMetrics exerciseId={id!} family={combined && !!variants} loadType={lt} unit={u} effort={effort} />
          <p className="faint chart-foot">e1RM = estimated one-rep max (Wathen equation on reps to failure = reps + RIR; LeSuer et al. 1997). e10RM = the weight for 10 reps to failure from the same equation (≈ 74% of e1RM). Hollow dots and ≥: no effort logged, so reps alone (a lower bound). Dim dots and ≈: more than {RELIABLE_MAX_RTF} reps to failure, where estimates are less accurate (Reynolds et al. 2006). No line is drawn across breaks longer than 6 weeks.</p>
        </>
      )}

      <div className="row" style={{ margin: '22px 0 10px' }}>
        <h2 className="section-title grow" style={{ margin: '0 6px' }}>Sessions</h2>
        <div className="seg range-seg" role="group" aria-label="Sessions: time range">
          {(['3M', '1Y', 'All'] as Range[]).map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
        </div>
      </div>
      <div className="stack">
        {newestFirst.map((r) => (
          <Link key={r.sessionId} to={`/session/${r.sessionId}`} className="card pressable" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="grow" style={{ fontWeight: 600 }}>{keyToDate(r.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: r.date.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' })}</span>
              {r.prCount > 0 && <span className="badge good num" aria-label={`${plural(r.prCount, 'personal record', 'personal records')}`}><Icon name="flag" size={12} /> PR{r.prCount > 1 ? ` ×${r.prCount}` : ''}</span>}
              {r.bestSet?.e1rmKg && <span className="badge accent num" title="Estimated one-rep max">Est. 1RM {r.bestSet.e1rmLowerBound ? '≥' : r.bestSet.e1rmReliable ? '' : '≈'}{fmtWeight(r.bestSet.e1rmKg, u)}</span>}
            </div>
            {combined && <div className="faint" style={{ fontSize: '0.8125rem', marginBottom: 2 }}>{r.exerciseIds.map(variantName).filter(Boolean).join(' + ')}</div>}
            <div className="num muted sess-meta">
              {plural(r.workingSets, 'set', 'sets')}{r.volumeKg > 0 ? ` · ${fmtVolume(r.volumeKg, u)}` : ''}{r.bestSet ? ` · best ${loadText(lt, r.bestSet.loadKg, u)} × ${r.bestSet.reps}` : ''}
            </div>
            <div className="stack" style={{ gap: 2 }}>
              {r.sets.map((l) => (
                <div key={l.id} className="num faint" style={{ fontSize: '0.875rem' }}>
                  {l.kind === 'warmup' ? 'Warm-up' : l.kind === 'drop' ? <><span aria-hidden>↳ </span>Drop set</> : `Set ${l.setNo}`}{l.side !== 'both' ? ` (${l.side})` : ''} · {setText(l, u, settings.effortMode)}{l.e1rm && <span title="Estimated one-rep max"> · e1RM {l.e1rm.lowerBound ? '≥' : l.e1rm.reliable ? '' : '≈'}{fmtWeight(l.e1rm.kg, u, false)}</span>}
                </div>
              ))}
            </div>
          </Link>
        ))}
        {!rows.length && <p className="empty">{data.totalSessions ? 'No sessions in this range.' : 'No sets logged for this exercise yet.'}</p>}
      </div>
      {ex && <Sheet open={info} onClose={() => setInfo(false)} title={exerciseLabel(ex)}><ExerciseInfo ex={ex} /></Sheet>}
    </div>
  );
}

function RecTile({ label, value, sub, to }: { label: string; value: string; sub: string; to: string }) {
  return (
    <Link to={to} className="rec-tile pressable">
      <span className="rec-label">{label}</span>
      <b className="rec-value">{value}</b>
      <span className="rec-meta num">{sub}</span>
    </Link>
  );
}

type MetricKey = 'e1rm' | 'e10rm' | 'top' | 'max' | 'vol' | 'reps' | 'sets' | 'wkvol' | 'wksets';
type SRow = ExerciseSeries['sessions'][number];
type WRow = ExerciseSeries['weeks'][number];
interface MetricDef { chip: string; title: string; note?: string; points: TPoint[]; fmt: (v: number) => string; kind?: 'line' | 'bar'; integer?: boolean; zero?: boolean; good?: 'up' | 'down' }

/** Metric switcher + one big maximizable chart, from progress.exerciseSeries (all time; the chart's own range chips zoom). */
function ExerciseMetrics({ exerciseId, family, loadType: lt, unit: u, effort }: { exerciseId: string; family: boolean; loadType: LoadType; unit: Unit; effort: (rir: number | null) => string }) {
  const data = useLiveQuery(() => run(progressExerciseSeries, { exerciseId, family }), [exerciseId, family]);
  const [metric, setMetric] = useState<MetricKey>('e1rm');
  const events = useChartEvents();
  const chart = useMemo(() => {
    if (!data) return null;
    const W = (kg: number) => Math.round(fromKg(kg, u) * 10) / 10;
    const fmtW = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${u}`;
    const fmtVol = (v: number) => `${Math.round(v).toLocaleString()} ${u}`;
    const S = data.sessions;
    const sp = (f: (r: SRow) => number | null, cap: (r: SRow) => string | undefined, flags: (r: SRow) => Partial<TPoint> = () => ({})): TPoint[] =>
      S.flatMap((r) => { const v = f(r); return v == null ? [] : [{ t: r.t, v, key: r.sessionId, caption: cap(r), ...flags(r) }]; });
    const wp = (f: (w: WRow) => number, cap: (w: WRow) => string): TPoint[] => data.weeks.map((w) => ({ t: w.t, v: f(w), key: w.weekStart, caption: cap(w), partial: w.inProgress }));
    const best = (r: SRow) => (r.bestSet ? `${loadText(lt, r.bestSet.loadKg, u)} × ${r.bestSet.reps}${effort(r.bestSet.rir)}` : undefined);
    const eFlags = (r: SRow) => ({ lowerBound: r.e1rmLowerBound, unreliable: r.e1rmUnreliable, pr: r.pr.e1rm });
    const bwNote = lt === 'weighted' ? 'Best set each session' : 'Best set each session, incl. bodyweight';
    const top: MetricDef = lt === 'assisted'
      ? { chip: 'Assist', title: 'Assistance', note: 'Least assistance each session · lower is stronger', points: sp((r) => (r.topLoadKg == null ? null : W(r.topLoadKg)), (r) => `× ${r.topReps}`, (r) => ({ pr: r.pr.top })), fmt: fmtW, good: 'down' }
      : { chip: lt === 'bodyweight' ? 'Added' : 'Top', title: lt === 'bodyweight' ? 'Heaviest added weight' : 'Heaviest weight', note: 'Heaviest working set each session',
        points: sp((r) => (r.topLoadKg == null || (lt === 'bodyweight' && !r.topLoadKg) ? null : W(r.topLoadKg)), (r) => `× ${r.topReps}`, (r) => ({ pr: r.pr.top })), fmt: fmtW, good: 'up' };
    const all: Record<MetricKey, MetricDef> = {
      e1rm: { chip: 'e1RM', title: 'Estimated 1RM', note: bwNote, points: sp((r) => (r.e1rmKg == null ? null : W(r.e1rmKg)), best, eFlags), fmt: fmtW, good: 'up' },
      e10rm: { chip: 'e10RM', title: 'Estimated 10RM', note: 'Weight for 10 reps to failure, from the best set', points: sp((r) => (r.e10rmKg == null ? null : W(r.e10rmKg)), best, eFlags), fmt: fmtW, good: 'up' },
      top,
      max: { chip: 'Max reps', title: 'Most reps in a set', points: sp((r) => r.mostReps || null, (r) => (r.topLoadKg != null ? loadText(lt, r.topLoadKg, u) : undefined), (r) => ({ pr: r.pr.mostReps })), fmt: (v) => plural(v, 'rep', 'reps'), integer: true, good: 'up' },
      vol: { chip: 'Vol', title: 'Session volume', note: 'Weight × reps, warm-ups excluded', points: sp((r) => (r.volumeKg > 0 ? Math.round(fromKg(r.volumeKg, u)) : null), (r) => plural(r.hardSets, 'set', 'sets'), (r) => ({ pr: r.pr.volume })), fmt: fmtVol, zero: true },
      reps: { chip: 'Reps', title: 'Total reps', note: 'Working and drop sets each session', points: sp((r) => r.totalReps || null, (r) => plural(r.hardSets, 'set', 'sets'), (r) => ({ pr: r.pr.totalReps })), fmt: (v) => plural(v, 'rep', 'reps'), integer: true, zero: true },
      sets: { chip: 'Sets', title: 'Hard sets per session', note: 'Working sets, a left + right pair counts once', points: sp((r) => r.hardSets || null, (r) => plural(r.totalReps, 'rep', 'reps')), fmt: (v) => plural(v, 'set', 'sets'), integer: true, zero: true },
      wkvol: { chip: 'Wk vol', title: 'Weekly volume', note: 'Weight × reps per week (Mon–Sun)', points: wp((w) => Math.round(fromKg(w.volumeKg, u)), (w) => (w.sessions ? `${plural(w.sessions, 'session', 'sessions')} · ${plural(w.hardSets, 'set', 'sets')}` : 'no sessions')), fmt: fmtVol, kind: 'bar' },
      wksets: { chip: 'Wk sets', title: 'Hard sets per week', note: 'Working sets per week (Mon–Sun)', points: wp((w) => w.hardSets, (w) => (w.sessions ? plural(w.sessions, 'session', 'sessions') : 'no sessions')), fmt: (v) => plural(v, 'set', 'sets'), kind: 'bar', integer: true },
    };
    const keys: MetricKey[] = ['e1rm', 'e10rm', ...(lt === 'weighted' || lt === 'assisted' || data.everAdded ? ['top' as const] : []), ...(lt !== 'weighted' ? ['max' as const] : []), 'vol', 'wkvol', 'sets', 'wksets', 'reps'];
    return { all, keys };
  }, [data, lt, u, effort]);
  if (!chart) return null;
  const key = chart.keys.includes(metric) ? metric : chart.keys[0];
  const c = chart.all[key];
  return (
    <TimeChart title={c.title} note={c.note} points={c.points} fmt={c.fmt} kind={c.kind ?? 'line'} integer={c.integer} zeroBased={c.zero} height={200} good={c.good} events={events}
      rowHref={c.kind === 'bar' ? undefined : (p) => (p.key ? `/session/${p.key}` : undefined)}
      header={(
        <div className="chips tc-metrics" role="group" aria-label="Metric">
          {chart.keys.map((k) => <button key={k} className="chip" aria-pressed={k === key} onClick={(e) => { setMetric(k); const row = e.currentTarget.parentElement!, b = e.currentTarget; if (b.offsetLeft < row.scrollLeft || b.offsetLeft + b.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollTo({ left: b.offsetLeft - 16, behavior: 'smooth' }); }}>{chart.all[k].chip}</button>)}
        </div>
      )} />
  );
}
