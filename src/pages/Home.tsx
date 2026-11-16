import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { ThumbPill } from '../components/ExThumb';
import { alive, db } from '../db/db';
import { activeSession, nextWorkoutId } from '../db/gym';
import { run } from '../api/registry';
import { sessionsStart } from '../api/gym';
import { suppTake } from '../api/body';
import { useSettings } from '../db/settings';
import type { BodyweightEntry, Macros, Session } from '../db/types';
import { fmtDate, fmtDuration, fmtWeight, plural, relDay } from '../lib/format';
import { useTick } from '../lib/rest';
import { fromKg } from '../lib/science';
import { WeighInSheet } from './Weight';
import { Ring, Summary, useDay } from './Food';
import { useSuppDay } from './Supplements';
import { fmtNum } from '../lib/format';
import { dateKey, goalHit, sum } from '../lib/nutrition';
import { useToday } from '../lib/today';
import { workingSetCount } from '../lib/workoutStats';

const DAY = 86400000;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const weekStart = (ts = Date.now()) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };

/** Home = dashboard of widgets. Each widget is a role-coloured tile; tap opens its page. */
export function HomePage() {
  const settings = useSettings();
  const [weighing, setWeighing] = useState(false);
  useToday(); // re-render the header date and every widget when the day rolls over
  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <div className="muted t-15" style={{ fontWeight: 560 }}>{fmtDate(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1>Today</h1>
        </div>
      </header>
      <div className="widgets">
        {settings.features.gym && <GymWidget />}
        {settings.features.food && <FoodWidget />}
        {settings.features.supplements && <SuppWidget />}
        <WeightWidget onLog={() => setWeighing(true)} />
        {settings.features.gym && <WeekWidget />}
        <CalendarWidget />
      </div>
      <WeighInSheet open={weighing} onClose={() => setWeighing(false)} />
    </div>
  );
}

export function Widget({ role, icon, title, onOpen, action, wide, children }: {
  role: 'gym' | 'weight' | 'food' | 'supp' | 'neutral'; icon: string; title: string; onOpen?: () => void; action?: ReactNode; wide?: boolean; children: ReactNode;
}) {
  return (
    <section className={'widget' + (wide ? ' wide' : '')} data-role={role}>
      <div className="widget-head">
        <button className="widget-title pressable" onClick={onOpen} disabled={!onOpen}>
          <span className="role-chip"><Icon name={icon} size={16} stroke={2} /></span>
          <span>{title}</span>
          {onOpen && wide && <Icon name="chevronRight" size={14} className="chev" />}
        </button>
        {action}
      </div>
      <div className="widget-body">{children}</div>
    </section>
  );
}

function GymWidget() {
  const nav = useNavigate();
  const settings = useSettings();
  const active = useLiveQuery(() => activeSession(), []);
  const plan = useLiveQuery(() => (settings.activePlanId ? db.plans.get(settings.activePlanId) : undefined), [settings.activePlanId]);
  const next = useLiveQuery(async () => {
    if (!plan || !alive(plan)) return undefined;
    const id = await nextWorkoutId(plan);
    return id ? db.workouts.get(id) : undefined;
  }, [plan]);
  const now = useTick(!!active, 1000);
  const start = async (workoutId?: string) => {
    if (active) return nav(`/session/${active.id}`);
    const { session } = await run(sessionsStart, { workoutId });
    nav(`/session/${session.id}`);
  };

  if (active) {
    return (
      <Widget role="gym" icon="dumbbell" title="Live" wide onOpen={() => nav(`/session/${active.id}`)}>
        <div className="row">
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="big-label ellipsis" style={{ display: 'block', marginBottom: 8 }}>{active.name}</span>
            <ThumbPill ids={active.items.map((i) => i.exerciseId)} />
          </span>
          <span className="num big-value" aria-label={`Running for ${fmtDuration(now - active.startedAt)}`}>{fmtDuration(now - active.startedAt)}</span>
          <button className="round-btn lg" aria-label={`Resume ${active.name}`} onClick={() => nav(`/session/${active.id}`)}><Icon name="play" size={22} /></button>
        </div>
      </Widget>
    );
  }
  return (
    <Widget role="gym" icon="dumbbell" title={plan && alive(plan) ? plan.name : 'Gym'} wide onOpen={() => nav('/plans')}
      action={<button className="icon-btn sm tint" aria-label="Start empty workout" onClick={() => start()}><Icon name="plus" size={18} /></button>}>
      {next ? (
        <div className="row">
          <div className="grow">
            <div className="faint w-6" style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Next</div>
            <div className="big-label ellipsis">{next.name}</div>
            <div className="muted t-13" style={{ marginBottom: 10 }}>{plural(next.items.length, 'exercise', 'exercises')} · {plural(next.items.reduce((a, i) => a + i.sets, 0), 'set', 'sets')}</div>
            <ThumbPill ids={next.items.map((i) => i.exerciseId)} />
          </div>
          <button className="round-btn lg" aria-label={`Start ${next.name}`} onClick={() => start(next.id)}><Icon name="play" size={22} /></button>
        </div>
      ) : (
        <button className="row pressable plain widget-cta" onClick={() => nav('/plans')}>
          <span className="grow">{plan ? 'Add a workout to this plan' : 'Create a plan'}</span>
          <Icon name="chevronRight" size={18} className="chev" />
        </button>
      )}
    </Widget>
  );
}

function WeightWidget({ onLog }: { onLog: () => void }) {
  const nav = useNavigate();
  const settings = useSettings();
  const recent = useLiveQuery(() => db.bodyweight.orderBy('at').reverse().filter(alive).limit(30).toArray(), []) ?? [];
  const last = recent[0];
  const due = !last || Date.now() - last.at > settings.weighInEveryDays * DAY;
  const delta = last && recent[1] ? fromKg(last.kg - recent[1].kg, settings.unit) : null;
  return (
    <Widget role="weight" icon="scale" title="Weight" onOpen={() => nav('/weight')}
      action={<button className="icon-btn sm tint" aria-label="Log weight" onClick={onLog}><Icon name="plus" size={18} /></button>}>
      {last ? (
        <>
          <div className="row" style={{ alignItems: 'baseline', gap: 4 }}>
            <span className="num big-value">{fmtWeight(last.kg, settings.unit, false)}</span>
            <span className="muted" style={{ fontSize: '0.8125rem' }}>{settings.unit}</span>
            {delta != null && Math.abs(delta) >= 0.05 && <span className="num delta"><span aria-hidden>{delta > 0 ? '▲' : '▼'}</span><span className="sr-only">{delta > 0 ? 'up' : 'down'} </span>{Math.abs(delta).toFixed(1)} {settings.unit}</span>}
          </div>
          <MiniLine entries={recent} />
          <div className={'w-6 ' + (due ? 'due' : 'faint')} style={{ fontSize: '0.75rem' }}>{due ? <><span aria-hidden>● </span>Weigh-in due</> : relDay(last.at)}</div>
        </>
      ) : (
        <button className="plain pressable weight-empty" onClick={onLog}>
          <span className="weight-empty-glyph" aria-hidden><Icon name="scale" size={20} stroke={2} /></span>
          <span><b>Log</b><span className="muted t-13" style={{ display: 'block' }}>your first weigh-in</span></span>
        </button>
      )}
    </Widget>
  );
}

function MiniLine({ entries }: { entries: BodyweightEntry[] }) {
  const pts = entries.slice(0, 14).reverse();
  if (pts.length < 2) return <div style={{ height: 28 }} />;
  const vals = pts.map((p) => p.kg), min = Math.min(...vals), span = Math.max(...vals) - min || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 100},${26 - ((p.kg - min) / span) * 22}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" width="100%" height="34" preserveAspectRatio="none" aria-hidden style={{ margin: '6px 0 4px' }}>
      <defs><linearGradient id="wfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--role)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--role)" stopOpacity="0" /></linearGradient></defs>
      <path d={d + ' L100,28 L0,28 Z'} fill="url(#wfill)" stroke="none" />
      <path d={d} fill="none" stroke="var(--role)" strokeWidth={2.2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WeekWidget() {
  const nav = useNavigate();
  const todayKey = useToday();
  const ws = useMemo(() => weekStart().getTime(), [todayKey]);
  const data = useLiveQuery(async () => {
    const sessions = await db.sessions.where('startedAt').aboveOrEqual(ws).filter((s) => alive(s) && !!s.endedAt).toArray();
    const ids = sessions.map((s) => s.id);
    const done = ids.length ? await db.sets.where('sessionId').anyOf(ids).filter((x) => alive(x) && !!x.doneAt).toArray() : [];
    const sets = ids.reduce((n, id) => n + workingSetCount(done.filter((x) => x.sessionId === id)), 0); // per session: slot keys repeat across sessions
    return { sessions, sets };
  }, [ws]);
  const days = new Set((data?.sessions ?? []).map((s) => (new Date(s.startedAt).getDay() + 6) % 7));
  const today = (new Date().getDay() + 6) % 7;
  return (
    <Widget role="gym" icon="chart" title="Week" onOpen={() => nav('/stats')}>
      <div className="row" style={{ alignItems: 'baseline', gap: 4 }}>
        <span className="num big-value">{data?.sessions.length ?? 0}</span>
        <span className="muted t-13">{(data?.sessions.length ?? 0) === 1 ? 'workout' : 'workouts'} · {plural(data?.sets ?? 0, 'set', 'sets')}</span>
      </div>
      <div className="week-dots" role="img" aria-label={days.size ? `Trained this week: ${[...days].sort().map((i) => DAY_NAMES[i]).join(', ')}` : 'No training days yet this week'}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l, i) => (
          <span key={i} aria-hidden className={(days.has(i) ? 'on' : '') + (i === today ? ' today' : '')}>{days.has(i) ? <Icon name="check" size={13} stroke={3} /> : l}</span>
        ))}
      </div>
    </Widget>
  );
}

function CalendarWidget() {
  const [expanded, setExpanded] = useState(false);
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [sel, setSel] = useState<string>();
  const nav = useNavigate();
  const settings = useSettings();

  useToday(); // the collapsed week and the today marker follow the date
  const start = expanded ? weekStart(month.getTime()) : weekStart();
  const count = expanded ? 42 : 7;
  const end = start.getTime() + count * DAY;
  const data = useLiveQuery(async () => {
    const [sessions, weights, entries, goals] = await Promise.all([
      db.sessions.where('startedAt').between(start.getTime(), end).filter((s) => alive(s) && !!s.endedAt).toArray(),
      db.bodyweight.where('at').between(start.getTime(), end).filter(alive).toArray(),
      db.entries.where('date').between(dateKey(start), dateKey(end - DAY), true, true).filter(alive).toArray(),
      db.goals.orderBy('effectiveFrom').filter(alive).toArray(),
    ]);
    // days where calories landed within ±10% of target and protein was met (see lib/nutrition goalHit)
    const byDate = new Map<string, Macros[]>();
    entries.forEach((e) => byDate.set(e.date, [...(byDate.get(e.date) ?? []), e.n]));
    const hits = new Set<string>();
    for (const [d, list] of byDate) {
      const g = [...goals].reverse().find((x) => x.effectiveFrom <= d) ?? goals[0];
      if (g && goalHit(sum(list), g.kcal, g.proteinG)) hits.add(d);
    }
    return { sessions, weights, hits };
  }, [start.getTime(), end]);
  const byDay = useMemo(() => {
    const m = new Map<string, { sessions: Session[]; weights: BodyweightEntry[] }>();
    const get = (k: string) => m.get(k) ?? (m.set(k, { sessions: [], weights: [] }), m.get(k)!);
    data?.sessions.forEach((s) => get(dayKey(s.startedAt)).sessions.push(s));
    data?.weights.forEach((w) => get(dayKey(w.at)).weights.push(w));
    return m;
  }, [data]);
  const days = Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * DAY + 3600000)); // +1h: DST-safe
  const today = dayKey(Date.now());
  const selData = sel ? byDay.get(sel) : undefined;
  const shift = (n: number) => { const d = new Date(month); d.setMonth(d.getMonth() + n); setMonth(d); setSel(undefined); };

  return (
    <Widget role="neutral" icon="calendar" wide title={expanded ? month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Calendar'}
      action={
        <div className="row" style={{ gap: 0 }}>
          {expanded && <>
            <button className="icon-btn sm" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="chevronLeft" size={18} /></button>
            <button className="icon-btn sm" aria-label="Next month" onClick={() => shift(1)}><Icon name="chevronRight" size={18} /></button>
          </>}
          <button className="icon-btn sm" aria-label={expanded ? 'Collapse calendar' : 'Expand calendar'} aria-expanded={expanded}
            onClick={() => { setExpanded(!expanded); setSel(undefined); const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonth(d); }}>
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ type: 'spring', bounce: 0, duration: 0.3 }} style={{ display: 'grid' }}>
              <Icon name="chevronDown" size={18} />
            </motion.span>
          </button>
        </div>
      }>
      <div className="cal">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} className="cal-dow">{d}</div>)}
        {days.map((d) => {
          const k = dayKey(d.getTime());
          const e = byDay.get(k);
          return (
            <button key={k} className={'cal-day' + (expanded && d.getMonth() !== month.getMonth() ? ' out' : '') + (k === today ? ' today' : '') + (k === sel ? ' sel' : '')}
              onClick={() => setSel(k === sel ? undefined : k)} aria-pressed={k === sel} aria-current={k === today ? 'date' : undefined}
              aria-label={(k === today ? 'Today, ' : '') + longDate.format(d) + (e?.sessions.length ? ', workout' : '') + (e?.weights.length ? ', weigh-in' : '') + (data?.hits.has(dateKey(d)) ? ', food goals hit' : '')}>
              <span className="num">{d.getDate()}</span>
              <span className="cal-dots" aria-hidden>
                {e?.sessions.length ? <i className="dot-workout" /> : null}
                {e?.weights.length ? <i className="dot-weight" /> : null}
                {data?.hits.has(dateKey(d)) ? <i className="dot-food" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <AnimatePresence initial={false}>
        {sel && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.3 }} style={{ overflow: 'hidden' }}>
            <div className="stack" style={{ gap: 6, paddingTop: 10 }}>
              {selData?.sessions.map((s) => (
                <button key={s.id} className="mini-row pressable" data-role="gym" onClick={() => nav(`/session/${s.id}`)}>
                  <span className="role-chip"><Icon name="dumbbell" size={14} stroke={2} /></span>
                  <span className="grow ellipsis">{s.name}</span>
                  <span className="num muted">{fmtDuration((s.endedAt ?? s.startedAt) - s.startedAt)}</span>
                </button>
              ))}
              {selData?.weights.map((w) => (
                <button key={w.id} className="mini-row pressable" data-role="weight" onClick={() => nav('/weight')}>
                  <span className="role-chip"><Icon name="scale" size={14} stroke={2} /></span>
                  <span className="grow num">{fmtWeight(w.kg, settings.unit)}</span>
                  <span className="muted">{new Date(w.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                </button>
              ))}
              {!selData && <p className="faint t-15" style={{ textAlign: 'center', margin: 4 }}>Nothing logged</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Widget>
  );
}

function FoodWidget() {
  const nav = useNavigate();
  const today = useToday();
  const { goal, total, entries } = useDay(today);
  return (
    <Widget role="food" icon="food" title="Food" wide onOpen={() => nav('/food')}
      action={<button className="icon-btn sm tint" aria-label="Log food" onClick={() => nav('/food')}><Icon name="plus" size={18} /></button>}>
      {goal ? <Summary total={total} goal={goal} compact /> : (
        <button className="row pressable plain widget-cta" onClick={() => nav('/nutrition')}>
          <span className="grow">{entries.length ? `${Math.round(total.kcal).toLocaleString()} kcal logged · set a goal` : 'Set your goals'}</span>
          <Icon name="chevronRight" size={18} className="chev" />
        </button>
      )}
    </Widget>
  );
}

function SuppWidget() {
  const nav = useNavigate();
  const today = useToday();
  const { day, done, total, sups } = useSuppDay(today);
  const pending = day.flatMap((g) => g.stacks.flatMap((st) => st.items)).filter((i) => !i.log).slice(0, 3);
  if (!sups.length) {
    return (
      <Widget role="supp" icon="pill" title="Supps" wide onOpen={() => nav('/supps')}
        action={<button className="icon-btn sm tint" aria-label="Add supplement" onClick={() => nav('/supps?new=1')}><Icon name="plus" size={18} /></button>}>
        <button className="row pressable plain widget-cta" onClick={() => nav('/supps')}>
          <span className="grow">Track supplements, meds and peptides</span>
          <Icon name="chevronRight" size={18} className="chev" />
        </button>
      </Widget>
    );
  }
  return (
    <Widget role="supp" icon="pill" title="Supps" wide onOpen={() => nav('/supps')}
      action={<button className="icon-btn sm tint" aria-label="Add supplement" onClick={() => nav('/supps?new=1')}><Icon name="plus" size={18} /></button>}>
      <div className="row" style={{ gap: 14, alignItems: 'center' }}>
        <Ring value={done} max={Math.max(1, total)} size={64} track={!total}><span className="num w-8" aria-label={total ? `${done} of ${total} taken` : 'Nothing scheduled'}>{total ? `${done}/${total}` : '–'}</span></Ring>
        <div className="grow stack" style={{ gap: 6, minWidth: 0 }}>
          {pending.length ? pending.map((d) => (
            <div key={d.sup.id + d.slot} className="row" style={{ gap: 8 }}>
              <span className="grow ellipsis" dir="auto" style={{ fontWeight: 600 }}>{d.sup.name}</span>
              <span className="muted num t-13">{d.slot === '--:--' ? '' : `${d.slot} · `}{fmtNum(d.amount)} {d.sup.unit}</span>
              <button className="check compact" aria-label={`Take ${d.sup.name}`}
                onClick={() => run(suppTake, { supplementId: d.sup.id, date: today, time: d.slot === '--:--' ? undefined : d.slot, amount: d.amount })}>
                <Icon name="check" size={16} stroke={2.8} />
              </button>
            </div>
          )) : <span className="muted">{total ? <>All taken today <span aria-hidden>✓</span></> : 'Nothing scheduled today'}</span>}
        </div>
      </div>
    </Widget>
  );
}
