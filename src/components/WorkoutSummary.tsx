// End-of-workout summary (reference: docs/design-refs/alpha-workout-summary.png): one badge with the improvement count,
// a stat strip (Nth workout · duration · week streak), exercise rows with PR / ↑ counts, muscle rows, then the optional
// post-workout survey. All numbers come from the sessions.summary command.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import type { z } from 'zod';
import { run } from '../api/registry';
import { sessionsRate, sessionsSummary, type WorkoutSummaryData } from '../api/gym';
import { useSettings } from '../db/settings';
import { db } from '../db/db';
import type { Exercise, LoadType, SurveyBody, SurveySleep, Unit } from '../db/types';
import { fmtDate, fmtWeight, plural, relDay, titleCase } from '../lib/format';
import { fromKg } from '../lib/science';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { ExThumb } from './ExThumb';
import { MuscleMap } from './MuscleMap';

type Ex = WorkoutSummaryData['exercises'][number];

/** Foster et al. 2001 modified CR-10 verbal anchors (unlabelled steps have none on the scale). */
const CR10: Record<number, string> = { 0: 'Rest', 1: 'Very, very easy', 2: 'Easy', 3: 'Moderate', 4: 'Somewhat hard', 5: 'Hard', 7: 'Very hard', 10: 'Maximal' };

const fmtVolume = (kg: number, unit: Unit) => `${Math.round(fromKg(kg, unit)).toLocaleString()}`;
const fmtMin = (min: number) => { const m = Math.round(min); return m < 60 ? { v: String(m), u: 'min' } : { v: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`, u: 'h' }; };
function loadText(loadType: LoadType, loadKg: number, unit: Unit) {
  if (loadType === 'weighted') return fmtWeight(loadKg, unit);
  if (loadType === 'bodyweight') return loadKg ? `BW+${fmtWeight(loadKg, unit)}` : 'BW';
  return `BW−${fmtWeight(loadKg, unit)}`;
}
/** e1RM shown to the nearest 0.5 kg, like the exercise history page (it's an estimate). */
const half = (kg: number) => Math.round(kg * 2) / 2;
const signed = (v: number, fmt: (x: number) => string) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v))}`;

/** celebrate: opened right after Finish (count-up + a short burst on the badge when something improved). */
export function WorkoutSummary({ open, sessionId, onClose, onDone, celebrate = false }: { open: boolean; sessionId: string; onClose: () => void; onDone: () => void; celebrate?: boolean }) {
  const settings = useSettings();
  const data = useLiveQuery(() => (open ? run(sessionsSummary, { id: sessionId }) : undefined), [open, sessionId]);
  const exMap = useLiveQuery(async () => {
    const ids = data?.exercises.map((e) => e.exerciseId) ?? [];
    return Object.fromEntries((await db.exercises.bulkGet(ids)).filter(Boolean).map((e) => [e!.id, e!])) as Record<string, Exercise>;
  }, [data?.exercises.map((e) => e.exerciseId).join()]) ?? {};
  const [order, setOrder] = useState<'workout' | 'improved'>('workout');
  const unit = settings.unit;
  const exercises = data ? (order === 'workout' ? data.exercises : [...data.exercises].sort((a, b) => (b.prSets * 2 + b.upSets) - (a.prSets * 2 + a.upSets))) : [];
  return (
    <Sheet open={open} onClose={onClose} full role="gym" title={data ? data.name : 'Summary'}>
      {data && (
        <div className="sum">
          <p className="faint sum-when">{relDay(Date.parse(data.startedAt))}{data.live ? ' · in progress' : ''}</p>

          <Badge data={data} celebrate={celebrate} />

          <div className="sum-strip sum-in" style={{ '--i': 1 } as CSSProperties}>
            <StripStat icon="bolt" tone="gold" value={<>{data.workoutNumber.toLocaleString()}<small>{ordinal(data.workoutNumber)}</small></>} label="workout" />
            <StripStat icon="timer" tone="gold" value={fmtMin(data.durationMin).v} label={fmtMin(data.durationMin).u === 'h' ? 'hours' : 'min'} />
            <StripStat icon="fire" tone="warm" value={<>{data.weekStreak}<small>w</small></>} label="streak" srLabel={`${plural(data.weekStreak, 'week', 'weeks')} in a row`} />
          </div>
          <p className="faint sum-caption num">
            {plural(data.totals.workingSets, 'set', 'sets')} · {fmtVolume(data.totals.volumeKg, unit)} {unit}
            {data.vsLastWorkout?.volumeDeltaPct != null && data.vsLastWorkout.volumeDeltaPct !== 0 && <> · <span className={data.vsLastWorkout.volumeDeltaPct > 0 ? 'good-text' : ''}>{signed(Math.round(data.vsLastWorkout.volumeDeltaPct), (x) => `${x}%`)}</span> vs {fmtDate(Date.parse(data.vsLastWorkout.date + 'T12:00'), { month: 'short', day: 'numeric' })}</>}
          </p>

          {data.exercises.length > 0 && <>
            <div className="sum-head">
              <span className="faint">{plural(data.exercises.length, 'exercise', 'exercises')}</span>
              <button className="text-link sum-sort" onClick={() => setOrder(order === 'workout' ? 'improved' : 'workout')}
                aria-label={`Sorted by ${order === 'workout' ? 'workout order' : 'most improved'}. Change`}>
                {order === 'workout' ? 'Workout order' : 'Most improved'}<Icon name="sort" size={18} />
              </button>
            </div>
            <div className="group sum-in" style={{ '--i': 2 } as CSSProperties}>
              {exercises.map((e) => <ExerciseRow key={e.exerciseId} e={e} ex={exMap[e.exerciseId]} unit={unit} />)}
            </div>
          </>}

          {data.muscles.length > 0 && <MuscleRows data={data} />}

          {settings.features.survey && <Survey sessionId={data.sessionId} survey={data.survey} />}

          <div className="sum-done">
            <button className="btn primary lg block" onClick={onDone}>Done</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; };

/** One big badge with the number of improvements (PR sets + sets that beat last time). */
function Badge({ data, celebrate }: { data: WorkoutSummaryData; celebrate: boolean }) {
  const n = data.improvements;
  const prs = data.exercises.reduce((a, e) => a + e.prSets, 0);
  const ups = n - prs;
  const reduce = useReducedMotion();
  const party = celebrate && n > 0 && !reduce;
  const shown = useCountUp(n, party);
  return (
    <div className={'sum-badge sum-in' + (party ? ' party' : celebrate && n > 0 ? ' glow' : '')} style={{ '--i': 0 } as CSSProperties}>
      {party && <Burst gold={prs > 0} />}
      <svg viewBox="0 0 200 150" width="200" height="150" aria-hidden className="sum-badge-art">
        <defs>
          <linearGradient id="sum-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffe08a" /><stop offset="0.55" stopColor="#ffc53d" /><stop offset="1" stopColor="#f29b17" />
          </linearGradient>
        </defs>
        <g fill="var(--card-3)">
          <circle cx="38" cy="38" r="6" /><circle cx="164" cy="36" r="6" /><circle cx="26" cy="112" r="5" /><circle cx="176" cy="110" r="5" />
          <path d="M44 78l4.4 8.9 9.8 1.4-7.1 6.9 1.7 9.8-8.8-4.6-8.8 4.6 1.7-9.8-7.1-6.9 9.8-1.4z" />
          <path d="M158 78l4.4 8.9 9.8 1.4-7.1 6.9 1.7 9.8-8.8-4.6-8.8 4.6 1.7-9.8-7.1-6.9 9.8-1.4z" />
        </g>
        <path d="M100 14l16.5 33.4 36.9 5.4-26.7 26 6.3 36.7L100 98.2l-33 17.3 6.3-36.7-26.7-26 36.9-5.4z"
          fill="url(#sum-gold)" stroke="url(#sum-gold)" strokeWidth="16" strokeLinejoin="round" />
        <path d="M100 14l16.5 33.4 36.9 5.4-26.7 26 6.3 36.7L100 98.2l-33 17.3 6.3-36.7-26.7-26 36.9-5.4z"
          fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="2" strokeLinejoin="round" transform="translate(0 -1)" />
      </svg>
      <span className="sum-badge-num num" aria-hidden>{n > 0 ? shown : <Icon name="check" size={40} stroke={3.4} />}</span>
      <p className="sum-badge-cap">
        {n > 0 ? <>
          {prs > 0 && <span className="pr-text"><Icon name="medal" size={16} stroke={2} />{plural(prs, 'PR', 'PRs')}</span>}
          {ups > 0 && <span className="good-text"><Icon name="arrowUp" size={16} stroke={2.4} />{plural(ups, 'set', 'sets')} beat last time</span>}
        </> : <span>Workout done</span>}
      </p>
    </div>
  );
}

function StripStat({ icon, tone, value, label, srLabel }: { icon: string; tone: 'gold' | 'warm'; value: ReactNode; label: string; srLabel?: string }) {
  return (
    <div className="sum-strip-item">
      <span className={'sum-strip-icon ' + tone} aria-hidden><Icon name={icon} size={26} stroke={2} /></span>
      <span>
        <span className="sum-strip-value num" aria-hidden={srLabel ? true : undefined}>{value}</span>
        <span className="sum-strip-label" aria-hidden={srLabel ? true : undefined}>{label}</span>
        {srLabel && <span className="sr-only">{srLabel}</span>}
      </span>
    </div>
  );
}

/** 0 → n over ~0.7 s (ease-out), once, when on; otherwise n straight away. */
function useCountUp(n: number, on: boolean) {
  const [v, setV] = useState(on ? 0 : n);
  useEffect(() => {
    if (!on) { setV(n); return; }
    let raf = 0; const t0 = performance.now(), dur = Math.min(900, 380 + n * 90);
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setV(Math.round(n * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [n, on]);
  return v;
}

/** A single quiet burst of small sparks from behind the badge: transform + opacity only, ~0.9 s, never loops. */
function Burst({ gold }: { gold: boolean }) {
  const sparks = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2 + (i % 2 ? 0.18 : 0);
    const d = 74 + (i % 3) * 16;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8, s: i % 3 === 0 ? 7 : 5, delay: (i % 4) * 25, tone: gold ? (i % 3 === 0 ? 'good' : 'gold') : (i % 3 === 0 ? 'gold' : 'good') };
  });
  return (
    <span className="sum-burst" aria-hidden>
      {sparks.map((p, i) => <i key={i} className={p.tone} style={{ '--x': `${p.x}px`, '--y': `${p.y}px`, '--s': `${p.s}px`, animationDelay: `${120 + p.delay}ms` } as CSSProperties} />)}
    </span>
  );
}

/** Post-workout survey as its own step between Finish and the summary: same questions and command, big targets,
 *  Skip / Done. The answers stay editable on the summary afterwards. */
export function SurveyStep({ open, sessionId, onNext }: { open: boolean; sessionId: string; onNext: () => void }) {
  const data = useLiveQuery(() => (open ? run(sessionsSummary, { id: sessionId }) : undefined), [open, sessionId]);
  const answered = !!data && (data.survey.sessionRpe != null || data.survey.sleep != null || data.survey.soreness != null);
  return (
    <Sheet open={open} onClose={onNext} full role="gym" title="How was it?">
      {data && (
        <div className="sum survey-step">
          <p className="muted t-15" style={{ margin: '0 2px 4px' }}>Three taps, all optional. Helps spot what makes a good session.</p>
          <Survey sessionId={data.sessionId} survey={data.survey} bare />
          <div className="survey-actions">
            <button className="btn lg" onClick={onNext}>Skip</button>
            <button className="btn primary lg" onClick={onNext}>{answered ? 'Done' : 'Next'}</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

const TREND = {
  up: { sym: '↑', label: 'beat last time', cls: 'up' },
  same: { sym: '=', label: 'same as last time', cls: 'same' },
  down: { sym: '↓', label: 'below last time', cls: 'down' },
  new: { sym: 'New', label: 'first time', cls: 'new' },
} as const;

/** Thumbnail, name · equipment, "N sets" with PR / ↑ counts; tap for the details (best set, est. 1RM, records). */
function ExerciseRow({ e, ex, unit }: { e: Ex; ex?: Exercise; unit: Unit }) {
  const [open, setOpen] = useState(false);
  const t = TREND[e.trend];
  const b = e.bestSet;
  const records: string[] = [];
  if (e.prs.e1rm) records.push(`Best est. 1RM ${fmtWeight(half(e.prs.e1rm.kg), unit)}`);
  if (e.prs.weight) records.push(`Heaviest ${loadText(e.loadType, e.prs.weight.loadKg, unit)}`);
  if (e.prs.reps) records.push(`Rep PR ${e.prs.reps.reps} × ${loadText(e.loadType, e.prs.reps.loadKg, unit)}`);
  return (
    <div>
      <button className="ex-row pressable" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ExThumb ex={ex} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="ex-row-name ellipsis">{e.exercise}</span>
          <span className="ex-row-sub sum-counts num">
            <span>{plural(e.sets, 'set', 'sets')}</span>
            {e.prSets > 0 && <span className="pr-text"><Icon name="medal" size={16} stroke={2} /><span className="sr-only">PR sets: </span>{e.prSets}</span>}
            {e.upSets > 0 && <span className="good-text"><Icon name="arrowUp" size={16} stroke={2.4} /><span className="sr-only">sets beat last time: </span>{e.upSets}</span>}
            {e.trend === 'new' && <span className="faint">new</span>}
          </span>
        </span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} className="chev" />
      </button>
      {open && (
        <div className="sum-detail num">
          {b && <div>Best set {loadText(e.loadType, b.loadKg, unit)} × {b.reps}{b.e1rmKg != null && ` · est. 1RM ${b.e1rmLowerBound ? '≥' : b.e1rmReliable ? '' : '≈'}${fmtWeight(half(b.e1rmKg), unit)}`}</div>}
          <div>{t.sym !== 'New' && <span className={'sum-trend-inline ' + t.cls} aria-hidden>{t.sym} </span>}{t.label.charAt(0).toUpperCase() + t.label.slice(1)}
            {e.beatByE1rm && e.e1rmDeltaKg ? ` · est. 1RM +${fmtWeight(half(e.e1rmDeltaKg), unit)}` : ''}</div>
          {records.length > 0 && <div className="pr-text">{records.join(' · ')}</div>}
          {e.bodyweight === 'missing' && <div className="faint">No weigh-in: bodyweight volume is a guess</div>}
        </div>
      )}
    </div>
  );
}

/** Muscle rows: a small body figure with that muscle lit, share of today's sets, sets today and this week. */
function MuscleRows({ data }: { data: WorkoutSummaryData }) {
  const total = data.muscles.reduce((a, m) => a + m.fractional, 0) || 1;
  const maxF = Math.max(1, ...data.muscles.map((m) => m.fractional));
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <>
      <div className="sum-head"><span className="faint">Muscles</span></div>
      <div className="group sum-in" style={{ '--i': 3 } as CSSProperties}>
        {data.muscles.map((m) => (
          <div key={m.muscle} className="ex-row">
            <span className="mm-tile" aria-hidden><MuscleMap primary={[m.muscle]} view="auto" height={54} label="" /></span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ex-row-name ellipsis">{titleCase(m.muscle)}</span>
              <span className="ex-row-sub num">{m.direct > 0 ? <>{plural(m.direct, 'set', 'sets')}{m.indirect > 0 && <span className="faint"> + {n(m.indirect)} indirect</span>}</> : <span className="faint">{n(m.indirect)} indirect</span>} · {Math.round((m.fractional / total) * 100)}%<span className="faint"> · week {m.week.direct > 0 ? n(m.week.direct) : ''}{m.week.indirect > 0 ? `${m.week.direct > 0 ? ' + ' : '+'}${n(m.week.indirect)}` : ''}</span></span>
              <span className="m-track sum-mtrack" aria-hidden>
                {m.direct > 0 && <span className="m-bar" style={{ width: `${(m.direct / maxF) * 100}%` }} />}
                {m.indirect > 0 && <span className="m-bar ind" style={{ left: `${(m.direct / maxF) * 100}%`, width: `${(m.indirect / 2 / maxF) * 100}%` }} />}
              </span>
            </span>
          </div>
        ))}
      </div>
      <p className="faint sum-caption" style={{ textAlign: 'left' }}>Direct = the exercise's main muscles; indirect = assisting muscles (lighter bar), counted ½ a set, a common convention. % = share of today's sets. Week = since Monday.</p>
    </>
  );
}

function Survey({ sessionId, survey: s, bare = false }: { sessionId: string; survey: WorkoutSummaryData['survey']; bare?: boolean }) {
  const rate = (p: Omit<z.input<typeof sessionsRate.input>, 'id'>) => run(sessionsRate, { id: sessionId, ...p });
  return (
    <>
      {!bare && <div className="sum-head"><span className="faint">How was it?</span></div>}
      <div className="card stack sum-survey" style={{ gap: 18 }}>
        <Q label="Effort" hint={s.sessionRpe != null ? (CR10[s.sessionRpe] ? `${s.sessionRpe} · ${CR10[s.sessionRpe]}` : String(s.sessionRpe)) : 'Whole session, 0–10'}>
          {/* CR-10 keeps its 0–10 values: 1–10 in a balanced 5 × 2 grid, 0 ("Rest") as a full-width row under it */}
          <div className="sum-rpe" role="group" aria-label="Session effort, 0 to 10">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0].map((v) => (
              <button key={v} className={'sum-opt num' + (v === 0 ? ' zero' : '')} aria-pressed={s.sessionRpe === v} aria-label={`${v}${CR10[v] ? `, ${CR10[v]}` : ''}`}
                onClick={() => rate({ sessionRpe: s.sessionRpe === v ? null : v })}>{v === 0 ? '0 · Rest' : v}</button>
            ))}
          </div>
        </Q>
        <Q label="Sleep last night">
          <Choice<SurveySleep> value={s.sleep} options={[['bad', 'Bad'], ['ok', 'OK'], ['good', 'Good']]} onChange={(v) => rate({ sleep: v })} />
        </Q>
        <Q label="Body">
          <Choice<SurveyBody> value={s.soreness} options={[['fresh', 'Fresh'], ['normal', 'Normal'], ['beat', 'Beat up']]} onChange={(v) => rate({ soreness: v })} />
        </Q>
        <label className="field">
          <span>Note</span>
          <textarea key={sessionId} aria-label="Note" className="input" rows={2} style={{ padding: 12, resize: 'vertical' }} defaultValue={s.note ?? ''}
            placeholder="Optional" onBlur={(e) => { if ((e.target.value || null) !== (s.note ?? null)) rate({ note: e.target.value || null }); }} />
        </label>
      </div>
      {!bare && <p className="faint sum-caption">All optional. Saved as you tap.</p>}
    </>
  );
}

function Q({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="grow" style={{ fontWeight: 600 }}>{label}</span>
        {hint && <span className="faint num" style={{ fontSize: '0.8125rem' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T | null; options: [T, string][]; onChange: (v: T | null) => void }) {
  return (
    <div className="sum-choice" role="group">
      {options.map(([v, l]) => (
        <button key={v} className="sum-opt" aria-pressed={value === v} onClick={() => onChange(value === v ? null : v)}>{l}</button>
      ))}
    </div>
  );
}
