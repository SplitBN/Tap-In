// Full calendar: month grid with day markers (workout, food goals / fully logged, weigh-in, supplements all taken),
// swipe or arrows between months, tap a day for its summary. Data comes from the calendar.range command
// (same markers the Home week strip shows). Month and selected day live in the URL (?m=YYYY-MM&d=YYYY-MM-DD),
// so Back from a workout or a food day returns here.
import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion, type PanInfo } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { run } from '../api/registry';
import { calendarRangeCmd, type CalendarDay } from '../api/calendar';
import { useSettings } from '../db/settings';
import { fmtWeight, plural } from '../lib/format';
import { dateKey, keyToDate, shiftDate } from '../lib/nutrition';
import { useToday } from '../lib/today';
import { journalList } from '../api/journal';
import { JournalSheet, journalRange } from './Journal';
type JEntry = Awaited<ReturnType<typeof journalList.run>>[number];

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
/** Monday on or before a date key. */
export const mondayOf = (key: string) => shiftDate(key, -((keyToDate(key).getDay() + 6) % 7));
const monthOf = (key: string) => key.slice(0, 7);
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return dateKey(d).slice(0, 7); };
const monthTitle = (m: string) => keyToDate(`${m}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/** Screen-reader words for a day's markers. */
export function markerWords(d?: CalendarDay) {
  if (!d) return '';
  const m = d.markers;
  return [m.workout && plural(d.workouts.length, 'workout', 'workouts'), m.foodGoalHit ? 'food goals hit' : m.foodComplete && 'food log complete',
    m.weighIn && 'weigh-in', m.suppsAllTaken && 'supplements all taken'].filter(Boolean).join(', ');
}

/** The little shapes under a date: workout = dot, food = square (filled: goals hit, outline: fully logged), weigh-in = ring, supps = diamond. */
export function DayDots({ d }: { d?: CalendarDay }) {
  const m = d?.markers;
  return (
    <span className="cal-dots" aria-hidden>
      {m?.workout ? <i className="dot-workout" /> : null}
      {m?.foodGoalHit ? <i className="dot-food" /> : m?.foodComplete ? <i className="dot-food-done" /> : null}
      {m?.weighIn ? <i className="dot-weight" /> : null}
      {m?.suppsAllTaken ? <i className="dot-supp" /> : null}
    </span>
  );
}

export function CalendarPage() {
  const nav = useNavigate();
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const sel = params.get('d') ?? undefined;
  const month = params.get('m') ?? (sel ? monthOf(sel) : monthOf(today));
  const setUrl = (m: string, d?: string) => setParams({ ...(m !== monthOf(today) || d ? { m } : {}), ...(d ? { d } : {}) }, { replace: true });

  const first = `${month}-01`;
  const gridStart = mondayOf(first);
  const days = Array.from({ length: 42 }, (_, i) => shiftDate(gridStart, i));
  const data = useLiveQuery(() => run(calendarRangeCmd, { from: days[0], to: days[41] }), [days[0]]);
  const byDate = new Map((data?.days ?? []).map((d) => [d.date, d]));
  const settings = useSettings();
  const journal = useLiveQuery(() => (settings.features.journal !== false ? run(journalList, { from: days[0], to: days[41] }) : Promise.resolve([])), [days[0], settings.features.journal]) ?? [];
  const journalOn = (k: string) => journal.filter((j) => j.date === k || (j.date < k && (j.ongoing ? k <= today : !!j.endDate && k <= j.endDate)));
  const counts = (data?.days ?? []).filter((d) => monthOf(d.date) === month).reduce((a, d) => ({ w: a.w + d.workouts.length, f: a.f + (d.markers.foodGoalHit ? 1 : 0) }), { w: 0, f: 0 });

  // direction of the last month change, for the slide (sign only; reduced motion turns it into a fade via MotionConfig)
  const dirRef = useRef(0);
  // two quick taps move two months: the second builds on the month the first asked for, not yet in the URL
  // (React Router's functional setSearchParams doesn't queue like React state)
  const pending = useRef<string | null>(null);
  useEffect(() => { pending.current = null; }, [month]);
  const go = (n: number) => {
    dirRef.current = n;
    pending.current = shiftMonth(pending.current ?? month, n);
    setUrl(pending.current);
  };
  const dir = dirRef.current;
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -60 || info.velocity.x < -500) go(1);
    else if (info.offset.x > 60 || info.velocity.x > 500) go(-1);
  };

  return (
    <div className="page" data-role="neutral">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/'))}><Icon name="chevronLeft" /></button>
        <h1 className="small grow cal-title" aria-live="polite">{monthTitle(month)}</h1>
        <button className="icon-btn" aria-label="Previous month" onClick={() => go(-1)}><Icon name="chevronLeft" size={20} /></button>
        <button className="icon-btn" aria-label="Next month" onClick={() => go(1)}><Icon name="chevronRight" size={20} /></button>
      </header>

      <div className="card cal-card">
        <div className="cal">
          {DOW.map((d, i) => <div key={i} className="cal-dow" aria-hidden>{d}</div>)}
        </div>
        <div className="cal-swipe">
          <AnimatePresence initial={false} mode="popLayout" custom={dir}>
            <motion.div key={month} className="cal" role="group" aria-label={monthTitle(month)}
              custom={dir}
              variants={{ enter: (d: number) => ({ x: d * 60, opacity: 0 }), center: { x: 0, opacity: 1 }, exit: (d: number) => ({ x: d * -60, opacity: 0 }) }}
              initial="enter" animate="center" exit="exit" transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.25} dragDirectionLock onDragEnd={onDragEnd}>
              {days.map((k) => {
                const d = byDate.get(k);
                const out = monthOf(k) !== month;
                const words = markerWords(d);
                const js = journalOn(k);
                return (
                  <button key={k} className={'cal-day' + (out ? ' out' : '') + (k === today ? ' today' : '') + (k === sel ? ' sel' : '') + (k > today ? ' future' : '') + (js.length ? ' has-journal' : '') + (js.some((j) => j.date === k) ? ' journal-start' : '')}
                    onClick={() => setUrl(month, k)} aria-current={k === today ? 'date' : undefined}
                    aria-label={(k === today ? 'Today, ' : '') + longDate.format(keyToDate(k)) + (words ? `, ${words}` : '') + (js.length ? `, ${js.map((j) => j.title).join(', ')}` : '')}>
                    <span className="num">{keyToDate(k).getDate()}</span>
                    <DayDots d={d} />
                  </button>
                );
              })}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="cal-foot">
          <span className="muted t-13 num">{plural(counts.w, 'workout', 'workouts')} · {plural(counts.f, 'goal day', 'goal days')}</span>
          {month !== monthOf(today) && <button className="text-link" onClick={() => setUrl(monthOf(today))}>Today</button>}
        </div>
      </div>

      <div className="cal-legend" aria-label="Legend">
        <span><i className="dot-workout" aria-hidden />Workout</span>
        <span><i className="dot-food" aria-hidden />Food goals</span>
        <span><i className="dot-food-done" aria-hidden />Complete log</span>
        <span><i className="dot-weight" aria-hidden />Weigh-in</span>
        <span><i className="dot-supp" aria-hidden />Supps all taken</span>
        {settings.features.journal !== false && <span><i className="dot-journal" aria-hidden />Journal</span>}
      </div>

      <DaySheet date={sel} day={sel ? byDate.get(sel) : undefined} journal={sel ? journalOn(sel) : []} onClose={() => setUrl(month)} />
    </div>
  );
}

function DaySheet({ date, day, journal, onClose }: { date?: string; day?: CalendarDay; journal: JEntry[]; onClose: () => void }) {
  const nav = useNavigate();
  const settings = useSettings();
  const today = useToday();
  const [adding, setAdding] = useState(false);
  const empty = (!day || (!day.workouts.length && !day.food && !day.weighIns.length && !day.supps)) && !journal.length;
  return (
    <Sheet open={!!date} onClose={onClose} title={date ? (date === today ? `Today · ${longDate.format(keyToDate(date))}` : longDate.format(keyToDate(date))) : undefined}>
      {date && (
        <div className="stack" style={{ gap: 8 }}>
          {journal.map((j) => (
            <button key={j.id} className="mini-row pressable" onClick={() => nav('/journal')}>
              <span className="role-chip jchip"><Icon name="book" size={14} stroke={2} /></span>
              <span className="grow ellipsis" dir="auto">{j.title}</span>
              <span className="muted t-13">{journalRange(j)}</span>
              <Icon name="chevronRight" size={16} className="chev" />
            </button>
          ))}
          {day?.workouts.map((w) => (
            <button key={w.id} className="mini-row pressable" data-role="gym" onClick={() => nav(`/session/${w.id}`)}>
              <span className="role-chip"><Icon name="dumbbell" size={14} stroke={2} /></span>
              <span className="grow ellipsis">{w.name}</span>
              <span className="num muted">{w.minutes} min</span>
              <Icon name="chevronRight" size={16} className="chev" />
            </button>
          ))}
          {day?.food && (
            <button className="mini-row pressable" data-role="food" onClick={() => nav(`/food?d=${date}`)}>
              <span className="role-chip"><Icon name="food" size={14} stroke={2} /></span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="num" style={{ display: 'block' }}>{day.food.kcal.toLocaleString()}{day.food.goalKcal ? ` / ${day.food.goalKcal.toLocaleString()}` : ''} kcal</span>
                <span className="muted num" style={{ display: 'block', fontWeight: 500 }}>P {day.food.p} · C {day.food.c} · F {day.food.f} g</span>
              </span>
              {day.markers.foodGoalHit ? <span className="badge good"><Icon name="check" size={12} stroke={3} /> Goals</span>
                : <DayStatusBadge status={day.food.status} source={day.food.statusSource} />}
              <Icon name="chevronRight" size={16} className="chev" />
            </button>
          )}
          {day?.weighIns.map((w) => (
            <button key={w.id} className="mini-row pressable" data-role="weight" onClick={() => nav('/weight')}>
              <span className="role-chip"><Icon name="scale" size={14} stroke={2} /></span>
              <span className="grow num">{fmtWeight(w.kg, settings.unit)}</span>
              <span className="muted">{new Date(w.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              <Icon name="chevronRight" size={16} className="chev" />
            </button>
          ))}
          {day?.supps && (
            <button className="mini-row pressable" data-role="supp" onClick={() => nav(date === today ? '/supps' : `/supps?d=${date}`)}>
              <span className="role-chip"><Icon name="pill" size={14} stroke={2} /></span>
              <span className="grow num">{day.supps.taken}/{day.supps.due} taken</span>
              {day.markers.suppsAllTaken && <span className="badge good"><Icon name="check" size={12} stroke={3} /> All</span>}
              <Icon name="chevronRight" size={16} className="chev" />
            </button>
          )}
          {empty && <p className="faint t-15" style={{ textAlign: 'center', margin: '8px 0' }}>{date > today ? 'Nothing planned' : 'Nothing logged'}</p>}
          {empty && date <= today && (
            <nav className="text-links" aria-label="Log for this day">
              <button className="text-link" onClick={() => nav(`/food?d=${date}`)}>Food</button>
              <button className="text-link" onClick={() => nav(date === today ? '/supps' : `/supps?d=${date}`)}>Supps</button>
            </nav>
          )}
          {settings.features.journal !== false && <button className="text-link" style={{ alignSelf: 'center' }} onClick={() => setAdding(true)}><Icon name="plus" size={14} stroke={2.4} /> Journal</button>}
          <JournalSheet entry={adding ? 'new' : null} date={date} onClose={() => setAdding(false)} />
        </div>
      )}
    </Sheet>
  );
}

function DayStatusBadge({ status, source }: { status: string; source: 'auto' | 'you' }) {
  if (status === 'complete') return <span className="badge accent">{source === 'you' ? <><Icon name="check" size={12} stroke={3} /> Confirmed</> : 'Complete'}</span>;
  if (status === 'partial') return <span className="badge warn-badge">Partial</span>;
  if (status === 'unsure') return <span className="badge">Unsure</span>;
  return null;
}
