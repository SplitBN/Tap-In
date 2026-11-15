import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ExerciseThumb } from '../components/ExercisePicker';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { alive, db } from '../db/db';
import { setOrder } from '../db/gym';
import { useSettings } from '../db/settings';
import type { SetLog } from '../db/types';
import { fmtDate, fmtDuration, fmtWeight, relDay } from '../lib/format';
import { e1rm, totalLoadKg } from '../lib/science';
import { ExerciseInfo, setText } from './Session';

export function HistoryPage() {
  const sessions = useLiveQuery(() => db.sessions.orderBy('startedAt').reverse().filter((s) => alive(s) && !!s.endedAt).limit(200).toArray(), []) ?? [];
  const counts = useLiveQuery(async () => {
    const m: Record<string, number> = {};
    for (const s of sessions) m[s.id] = await db.sets.where('sessionId').equals(s.id).filter((x) => alive(x) && !!x.doneAt && x.kind !== 'warmup').count();
    return m;
  }, [sessions]) ?? {};
  return (
    <div className="page">
      <header className="page-head"><h1>History</h1></header>
      {sessions.length ? (
        <div className="list">
          {sessions.map((s) => (
            <Link key={s.id} to={`/session/${s.id}`} className="list-item pressable">
              <span className="grow">
                <span className="title">{s.name}</span>
                <span className="sub" style={{ display: 'block' }}>{relDay(s.startedAt)} · {fmtDuration((s.endedAt ?? s.startedAt) - s.startedAt)} · {counts[s.id] ?? '…'} sets</span>
              </span>
              <Icon name="chevronRight" className="chev" size={18} />
            </Link>
          ))}
        </div>
      ) : <div className="empty"><Icon name="history" size={40} /><h3>No workouts yet</h3><p>Finished workouts show up here.</p></div>}
    </div>
  );
}

/** Per-exercise history. Analytics (e1RM trend etc.) will grow here. */
export function ExerciseHistoryPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const settings = useSettings();
  const ex = useLiveQuery(() => db.exercises.get(id!), [id]);
  const [info, setInfo] = useState(false);
  const groups = useLiveQuery(async () => {
    const sets = await db.sets.where('exerciseId').equals(id!).filter((x) => alive(x) && !!x.doneAt).toArray();
    const bySession = new Map<string, SetLog[]>();
    sets.forEach((s) => bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s]));
    const sessions = (await db.sessions.bulkGet([...bySession.keys()])).filter(alive);
    return sessions.sort((a, b) => b.startedAt - a.startedAt).map((s) => ({ s, sets: bySession.get(s.id)!.sort(setOrder) }));
  }, [id]) ?? [];

  if (!ex) return null;
  const best = (sets: SetLog[]) => {
    let top: { kg: number; reliable: boolean } | undefined;
    for (const l of sets) {
      if (l.kind === 'warmup' || !l.reps) continue;
      const est = e1rm(totalLoadKg(l.loadType, l.loadKg, l.bodyweightKg), l.reps, l.rir ?? 0);
      if (!top || est.kg > top.kg) top = est;
    }
    return top;
  };
  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" /></button>
        <h1 className="small ellipsis">{ex.name}</h1>
        <button className="icon-btn" aria-label="How to do it" onClick={() => setInfo(true)}><Icon name="info" size={20} /></button>
      </header>
      <div className="row card" style={{ marginBottom: 12 }}>
        <ExerciseThumb ex={ex} size={56} />
        <div className="grow">
          <div className="muted" style={{ fontSize: '0.8125rem' }}>Sessions logged</div>
          <div style={{ fontWeight: 700, fontSize: '1.25rem' }} className="num">{groups.length}</div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: '0.8125rem', margin: '0 4px 8px' }}>e1RM = estimated one-rep max (Epley, using reps + RIR). Marked ≈ when based on more than 10 reps to failure, where estimates are less accurate.</p>
      <div className="stack">
        {groups.map(({ s, sets }) => {
          const b = best(sets);
          return (
            <Link key={s.id} to={`/session/${s.id}`} className="card pressable" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="grow" style={{ fontWeight: 600 }}>{fmtDate(s.startedAt)}</span>
                {b && <span className="badge accent num">e1RM {b.reliable ? '' : '≈'}{fmtWeight(Math.round(b.kg * 2) / 2, settings.unit)}</span>}
              </div>
              <div className="stack" style={{ gap: 2 }}>
                {sets.map((l) => (
                  <div key={l.id} className="num muted" style={{ fontSize: '0.875rem' }}>
                    {l.kind === 'warmup' ? 'Warm-up' : l.kind === 'drop' ? '↳ drop' : `Set ${l.setNo}`}{l.side !== 'both' ? ` (${l.side})` : ''} · {setText(l, settings.unit, settings.effortMode)}
                  </div>
                ))}
              </div>
            </Link>
          );
        })}
        {!groups.length && <p className="empty">No sets logged for this exercise yet.</p>}
      </div>
      <Sheet open={info} onClose={() => setInfo(false)} title={ex.name}><ExerciseInfo ex={ex} /></Sheet>
    </div>
  );
}
