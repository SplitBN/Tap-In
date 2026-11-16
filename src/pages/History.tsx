import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ExName, ExerciseThumb } from '../components/ExercisePicker';
import { exerciseLabel } from '../lib/equipment';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { LineChart, type LinePoint } from '../components/Charts';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import type { LoadType, SetLog, Unit } from '../db/types';
import { fmtWeight, plural, relDay, setText } from '../lib/format';
import { dateKey, keyToDate, shiftDate } from '../lib/nutrition';
import { fromKg } from '../lib/science';
import { run } from '../api/registry';
import { progressExercise, progressSessions, type ExerciseProgress } from '../api/progress';
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
      ) : <div className="empty"><Icon name="history" size={40} /><h3>No workouts yet</h3><p>Finished workouts land here.</p><Link to="/" className="btn primary"><Icon name="play" size={18} /> Start a workout</Link></div>}
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
type Row = ExerciseProgress['sessions'][number];

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
  const data = useLiveQuery(() => run(progressExercise, { exerciseId: id!, from }), [id, from]);

  if (!data) return null;
  const lt = data.exercise.loadType;
  // effort in the user's chosen notation, like the set list (RPE = 10 − RIR)
  const effort = (rir: number | null) => (rir == null ? '' : settings.effortMode === 'rir' ? ` @${rir} RIR` : ` @${10 - rir}`);
  const rows = data.sessions;
  const t = (r: Row) => Date.parse(r.startedAt);
  const W = (kg: number) => Math.round(fromKg(kg, u) * 10) / 10;
  const fmtW = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${u}`;

  const e1rmPts: LinePoint[] = rows.filter((r) => r.bestSet?.e1rmKg).map((r) => ({ t: t(r), v: W(r.bestSet!.e1rmKg!), approx: !r.bestSet!.e1rmReliable,
    caption: `${loadText(lt, r.bestSet!.loadKg, u)} × ${r.bestSet!.reps}${effort(r.bestSet!.rir)}` }));
  const volPts: LinePoint[] = rows.filter((r) => r.volumeKg > 0).map((r) => ({ t: t(r), v: Math.round(fromKg(r.volumeKg, u)), caption: plural(r.workingSets, 'set', 'sets') }));
  const repsPts: LinePoint[] = rows.filter((r) => r.mostReps > 0).map((r) => ({ t: t(r), v: r.mostReps, caption: r.heaviest ? loadText(lt, r.heaviest.loadKg, u) : undefined }));
  const heavyPts: LinePoint[] = rows.filter((r) => r.heaviest).map((r) => ({ t: t(r), v: W(r.heaviest!.loadKg), caption: `× ${r.heaviest!.reps}` }));
  const everAdded = data.sessions.some((r) => (r.heaviest?.loadKg ?? 0) > 0) || (data.records.heaviest?.loadKg ?? 0) > 0;

  const charts: { key: string; title: string; note?: string; pts: LinePoint[]; fmt: (v: number) => string; integer?: boolean }[] = [
    { key: 'e1rm', title: 'Estimated 1RM', note: lt === 'weighted' ? 'Best set each session' : 'Best set each session, incl. bodyweight', pts: e1rmPts, fmt: fmtW },
    ...(lt === 'weighted' ? [{ key: 'heavy', title: 'Heaviest weight', pts: heavyPts, fmt: fmtW }] : [
      { key: 'reps', title: 'Most reps in a set', pts: repsPts, fmt: (v: number) => `${v} reps`, integer: true },
      ...(lt === 'bodyweight' && everAdded ? [{ key: 'heavy', title: 'Heaviest added weight', pts: heavyPts, fmt: fmtW }] : []),
      ...(lt === 'assisted' ? [{ key: 'heavy', title: 'Assistance', note: 'Lower is stronger', pts: heavyPts, fmt: fmtW }] : []),
    ]),
    { key: 'vol', title: 'Session volume', note: 'Weight × reps, warm-ups excluded', pts: volPts, fmt: (v: number) => `${v.toLocaleString()} ${u}` },
  ];

  const rec = data.records;
  const newestFirst = [...rows].reverse();
  return (
    <div className="page wide" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{ex ? <ExName ex={ex} /> : data.exercise.label}</h1>
        {ex && <button className="icon-btn" aria-label="How to do it" onClick={() => setInfo(true)}><Icon name="info" size={20} /></button>}
      </header>

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
              {rec.bestE1rm && <RecTile label="Est. 1RM" value={`${rec.bestE1rm.reliable ? '' : '≈'}${fmtWeight(rec.bestE1rm.kg, u)}`}
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

          <div className="row" style={{ margin: '22px 0 10px' }}>
            <h2 className="section-title grow" style={{ margin: '0 6px' }}>Progress</h2>
            <div className="seg range-seg" role="group" aria-label="Time range">
              {(['3M', '1Y', 'All'] as Range[]).map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
            </div>
          </div>
          <div className="chart-grid">
            {charts.map((c) => (
              <section key={c.key} className="card chart-card" aria-label={c.title}>
                <h3 className="chart-title">{c.title}</h3>
                {c.note && <div className="chart-note">{c.note}</div>}
                <LineChart points={c.pts} fmt={c.fmt} label={c.title} integer={c.integer} />
              </section>
            ))}
          </div>
          <p className="faint chart-foot">e1RM = estimated one-rep max (Epley, using reps + RIR). ≈ and hollow dots: based on more than 10 reps to failure, where estimates are less accurate (Reynolds et al. 2006).</p>
        </>
      )}

      <h2 className="section-title">Sessions{range !== 'All' ? ` · last ${range === '3M' ? '3 months' : 'year'}` : ''}</h2>
      <div className="stack">
        {newestFirst.map((r) => (
          <Link key={r.sessionId} to={`/session/${r.sessionId}`} className="card pressable" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="grow" style={{ fontWeight: 600 }}>{keyToDate(r.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: r.date.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' })}</span>
              {r.prCount > 0 && <span className="badge good num" aria-label={`${plural(r.prCount, 'personal record', 'personal records')}`}><Icon name="flag" size={12} /> PR{r.prCount > 1 ? ` ×${r.prCount}` : ''}</span>}
              {r.bestSet?.e1rmKg && <span className="badge accent num" title="Estimated one-rep max">Est. 1RM {r.bestSet.e1rmReliable ? '' : '≈'}{fmtWeight(r.bestSet.e1rmKg, u)}</span>}
            </div>
            <div className="num muted sess-meta">
              {plural(r.workingSets, 'set', 'sets')}{r.volumeKg > 0 ? ` · ${fmtVolume(r.volumeKg, u)}` : ''}{r.bestSet ? ` · best ${loadText(lt, r.bestSet.loadKg, u)} × ${r.bestSet.reps}` : ''}
            </div>
            <div className="stack" style={{ gap: 2 }}>
              {r.sets.map((l) => (
                <div key={l.id} className="num faint" style={{ fontSize: '0.875rem' }}>
                  {l.kind === 'warmup' ? 'Warm-up' : l.kind === 'drop' ? <><span aria-hidden>↳ </span>Drop set</> : `Set ${l.setNo}`}{l.side !== 'both' ? ` (${l.side})` : ''} · {setText(l as SetLog, u, settings.effortMode)}
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
