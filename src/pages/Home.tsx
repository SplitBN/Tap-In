import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { alive, db } from '../db/db';
import { activeSession, nextWorkoutId, startSession } from '../db/gym';
import { useSettings } from '../db/settings';
import { fmtDate, fmtDuration, fmtWeight, relDay } from '../lib/format';
import { useTick } from '../lib/rest';
import { WeighInSheet } from './Weight';

const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export function HomePage() {
  const nav = useNavigate();
  const settings = useSettings();
  const active = useLiveQuery(() => activeSession(), []);
  const plan = useLiveQuery(() => (settings.activePlanId ? db.plans.get(settings.activePlanId) : undefined), [settings.activePlanId]);
  const next = useLiveQuery(async () => {
    if (!plan || !alive(plan)) return undefined;
    const id = await nextWorkoutId(plan);
    return id ? db.workouts.get(id) : undefined;
  }, [plan]);
  const lastWeigh = useLiveQuery(() => db.bodyweight.orderBy('at').reverse().filter(alive).first(), []);
  const [weighing, setWeighing] = useState(false);
  const now = useTick(!!active, 1000);

  const weighDue = !lastWeigh || now - lastWeigh.at > settings.weighInEveryDays * 86400000;
  const start = async (workoutId?: string) => {
    if (active) return nav(`/session/${active.id}`);
    const w = workoutId ? await db.workouts.get(workoutId) : undefined;
    const s = await startSession(w);
    nav(`/session/${s.id}`);
  };
  const hello = new Date().getHours() < 12 ? 'Morning' : new Date().getHours() < 18 ? 'Afternoon' : 'Evening';

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <div className="muted" style={{ fontSize: '0.875rem', fontWeight: 560 }}>{fmtDate(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1>{hello}</h1>
        </div>
      </header>

      {active ? (
        <Link to={`/session/${active.id}`} className="card pressable row" style={{ background: 'var(--accent)', color: 'var(--accent-text)', textDecoration: 'none', padding: 16 }}>
          <div className="grow">
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, opacity: 0.85 }}>Workout in progress</div>
            <div style={{ fontWeight: 700, fontSize: '1.125rem' }}>{active.name}</div>
          </div>
          <div className="num" style={{ fontWeight: 750, fontSize: '1.375rem' }}>{fmtDuration(now - active.startedAt)}</div>
          <Icon name="chevronRight" />
        </Link>
      ) : settings.features.gym && (
        <div className="card" style={{ padding: 16 }}>
          {next ? (
            <>
              <div className="muted" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Up next · {plan?.name}</div>
              <div style={{ fontWeight: 750, fontSize: '1.375rem', letterSpacing: '-0.015em', margin: '2px 0 12px' }}>{next.name}</div>
              <div className="row">
                <button className="btn primary lg grow" onClick={() => start(next.id)}><Icon name="play" size={18} /> Start workout</button>
                <button className="btn lg" onClick={() => nav(plan ? `/plans/${plan.id}` : '/plans')} aria-label="Pick another workout">Other</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700, fontSize: '1.125rem' }}>Ready to train?</div>
              <p className="muted" style={{ margin: '4px 0 12px', fontSize: '0.9375rem' }}>{plan ? 'Your plan has no workouts yet.' : 'Make a plan to get the next workout suggested here.'}</p>
              <div className="row">
                <button className="btn primary grow" onClick={() => nav(plan ? `/plans/${plan.id}` : '/plans')}>{plan ? 'Add workouts' : 'Create a plan'}</button>
                <button className="btn" onClick={() => start()}>Empty workout</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button className="card pressable grow row" style={{ border: 0, color: 'inherit', textAlign: 'left' }} onClick={() => setWeighing(true)}>
          <span style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'rgba(255,181,71,.15)', color: 'var(--warn)' }}><Icon name="scale" size={20} /></span>
          <span className="grow">
            <span style={{ display: 'block', fontWeight: 650 }}>{lastWeigh ? fmtWeight(lastWeigh.kg, settings.unit) : 'Log weight'}</span>
            <span className="muted" style={{ fontSize: '0.8125rem' }}>{weighDue ? (lastWeigh ? 'Weigh-in due' : 'No weigh-ins yet') : relDay(lastWeigh!.at)}</span>
          </span>
          {weighDue && <span className="badge" style={{ background: 'rgba(255,181,71,.15)', color: 'var(--warn)' }}>Due</span>}
        </button>
      </div>

      <div className="section-title">Calendar</div>
      <Calendar />

      <WeighInSheet open={weighing} onClose={() => setWeighing(false)} />
    </div>
  );
}

function Calendar() {
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [sel, setSel] = useState<string>();
  const nav = useNavigate();
  const settings = useSettings();
  const start = new Date(month); start.setDate(1 - ((month.getDay() + 6) % 7)); // weeks start Monday
  const end = new Date(start); end.setDate(start.getDate() + 42);
  const data = useLiveQuery(async () => {
    const [sessions, weights] = await Promise.all([
      db.sessions.where('startedAt').between(start.getTime(), end.getTime()).filter((s) => alive(s) && !!s.endedAt).toArray(),
      db.bodyweight.where('at').between(start.getTime(), end.getTime()).filter(alive).toArray(),
    ]);
    return { sessions, weights };
  }, [month.getTime()]);
  const byDay = useMemo(() => {
    const m = new Map<string, { sessions: NonNullable<typeof data>['sessions']; weights: NonNullable<typeof data>['weights'] }>();
    const get = (k: string) => m.get(k) ?? (m.set(k, { sessions: [], weights: [] }), m.get(k)!);
    data?.sessions.forEach((s) => get(dayKey(s.startedAt)).sessions.push(s));
    data?.weights.forEach((w) => get(dayKey(w.at)).weights.push(w));
    return m;
  }, [data]);
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = dayKey(Date.now());
  const selData = sel ? byDay.get(sel) : undefined;
  const shift = (n: number) => { const d = new Date(month); d.setMonth(d.getMonth() + n); setMonth(d); setSel(undefined); };

  return (
    <div className="card" style={{ padding: '10px 10px 12px' }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="icon-btn" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="chevronLeft" size={20} /></button>
        <div className="grow" style={{ textAlign: 'center', fontWeight: 650 }}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
        <button className="icon-btn" aria-label="Next month" onClick={() => shift(1)}><Icon name="chevronRight" size={20} /></button>
      </div>
      <div className="cal">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} className="cal-dow">{d}</div>)}
        {days.map((d) => {
          const k = dayKey(d.getTime());
          const e = byDay.get(k);
          return (
            <button key={k} className={'cal-day' + (d.getMonth() !== month.getMonth() ? ' out' : '') + (k === today ? ' today' : '') + (k === sel ? ' sel' : '')}
              onClick={() => setSel(k === sel ? undefined : k)} aria-label={d.toDateString() + (e?.sessions.length ? ', worked out' : '') + (e?.weights.length ? ', weighed in' : '')}>
              <span className="num">{d.getDate()}</span>
              <span className="cal-dots">
                {e?.sessions.length ? <i className="dot-workout" /> : null}
                {e?.weights.length ? <i className="dot-weight" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: 'center', gap: 14, marginTop: 8, fontSize: '0.75rem', color: 'var(--text-2)' }}>
        <span className="row" style={{ gap: 5 }}><i className="dot-workout" style={{ width: 7, height: 7, borderRadius: 4, display: 'inline-block' }} />Workout</span>
        <span className="row" style={{ gap: 5 }}><i className="dot-weight" style={{ width: 7, height: 7, borderRadius: 4, display: 'inline-block' }} />Weigh-in</span>
        {settings.features.food && <span className="row" style={{ gap: 5 }}><i className="dot-food" style={{ width: 7, height: 7, borderRadius: 4, display: 'inline-block' }} />Goals hit</span>}
      </div>
      {sel && (
        <div className="stack" style={{ marginTop: 10, gap: 6 }}>
          {selData?.sessions.map((s) => (
            <button key={s.id} className="list-item pressable" style={{ background: 'var(--card-2)', borderRadius: 12 }} onClick={() => nav(`/session/${s.id}`)}>
              <Icon name="dumbbell" size={18} /><span className="grow title">{s.name}</span>
              <span className="muted num" style={{ fontSize: '0.8125rem' }}>{fmtDuration((s.endedAt ?? s.startedAt) - s.startedAt)}</span>
            </button>
          ))}
          {selData?.weights.map((w) => (
            <div key={w.id} className="list-item" style={{ background: 'var(--card-2)', borderRadius: 12 }}>
              <Icon name="scale" size={18} /><span className="grow title">{fmtWeight(w.kg, settings.unit)}</span>
              <span className="muted" style={{ fontSize: '0.8125rem' }}>{new Date(w.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          ))}
          {!selData && <p className="muted" style={{ textAlign: 'center', margin: 4, fontSize: '0.875rem' }}>Nothing logged.</p>}
        </div>
      )}
    </div>
  );
}
