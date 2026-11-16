// End-of-workout summary: big stats, PR / beat-last-time highlights, per-exercise trend, sets per muscle,
// then the optional post-workout survey — one screen. All numbers come from the sessions.summary command.
import { useLiveQuery } from 'dexie-react-hooks';
import type { CSSProperties, ReactNode } from 'react';
import type { z } from 'zod';
import { run } from '../api/registry';
import { sessionsRate, sessionsSummary, type WorkoutSummaryData } from '../api/gym';
import { useSettings } from '../db/settings';
import type { LoadType, SurveyBody, SurveySleep, Unit } from '../db/types';
import { fmtWeight, plural, relDay, titleCase } from '../lib/format';
import { fromKg } from '../lib/science';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

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

export function WorkoutSummary({ open, sessionId, onClose, onDone }: { open: boolean; sessionId: string; onClose: () => void; onDone: () => void }) {
  const settings = useSettings();
  const data = useLiveQuery(() => (open ? run(sessionsSummary, { id: sessionId }) : undefined), [open, sessionId]);
  const unit = settings.unit;
  return (
    <Sheet open={open} onClose={onClose} full role="gym" title={data ? data.name : 'Summary'}>
      {data && (
        <div className="sum">
          <p className="faint sum-when">{relDay(Date.parse(data.startedAt))}{data.live ? ' · in progress' : ''}</p>

          <div className="sum-stats sum-in" style={{ '--i': 0 } as CSSProperties}>
            <Stat label="Time" {...fmtMin(data.durationMin)}
              delta={data.vsLastWorkout && Math.abs(data.vsLastWorkout.durationDeltaMin) >= 1 ? { text: signed(Math.round(data.vsLastWorkout.durationDeltaMin), (x) => `${x} min`) } : undefined} />
            <Stat label="Volume" v={fmtVolume(data.totals.volumeKg, unit)} u={unit}
              delta={data.vsLastWorkout?.volumeDeltaPct != null && data.vsLastWorkout.volumeDeltaPct !== 0
                ? { text: signed(Math.round(data.vsLastWorkout.volumeDeltaPct), (x) => `${x}%`), tone: data.vsLastWorkout.volumeDeltaPct > 0 ? 'good' : 'bad' } : undefined} />
            <Stat label="Sets" v={String(data.totals.workingSets)} u=""
              delta={data.vsLastWorkout && data.vsLastWorkout.setsDelta ? { text: signed(data.vsLastWorkout.setsDelta, String) } : undefined} />
          </div>
          <p className="faint sum-caption">Volume = weight × reps{data.vsLastWorkout ? ` · vs last ${data.name}, ${relDay(Date.parse(data.vsLastWorkout.date + 'T12:00')).toLowerCase()}` : ''}</p>

          <Highlights data={data} unit={unit} />

          {data.exercises.length > 0 && <>
            <div className="section-title">Exercises</div>
            <div className="list sum-in" style={{ '--i': 2 } as CSSProperties}>
              {data.exercises.map((e) => <ExerciseRow key={e.exerciseId} e={e} unit={unit} />)}
            </div>
          </>}

          {data.muscles.length > 0 && <MuscleBars data={data} />}

          {settings.features.survey && <Survey data={data} />}

          <div className="sum-done">
            <button className="btn primary lg block" onClick={onDone}>Done</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Stat({ label, v, u, delta }: { label: string; v: string; u: string; delta?: { text: string; tone?: 'good' | 'bad' } }) {
  return (
    <div className="sum-stat">
      <div className="sum-stat-label">{label}</div>
      <div className="sum-stat-value num">{v}{u && <span className="sum-stat-unit">{u}</span>}</div>
      {delta && <div className={'sum-delta num ' + (delta.tone ?? '')}>{delta.text}</div>}
    </div>
  );
}

function Highlights({ data, unit }: { data: WorkoutSummaryData; unit: Unit }) {
  const rows = data.exercises.map((e) => {
    const parts: { pr: boolean; text: string }[] = [];
    if (e.prs.e1rm) parts.push({ pr: true, text: `Best est. 1RM ${fmtWeight(half(e.prs.e1rm.kg), unit)}` });
    if (e.prs.weight) parts.push({ pr: true, text: `Heaviest ${loadText(e.loadType, e.prs.weight.loadKg, unit)}` });
    if (e.prs.reps) parts.push({ pr: true, text: `Rep PR ${e.prs.reps.reps} × ${loadText(e.loadType, e.prs.reps.loadKg, unit)}` });
    if (!parts.length && e.trend === 'up')
      parts.push({ pr: false, text: e.beatByE1rm && e.e1rmDeltaKg ? `Beat last time · est. 1RM +${fmtWeight(half(e.e1rmDeltaKg), unit)}` : 'Beat last time · more reps' });
    return { e, parts };
  }).filter((r) => r.parts.length).sort((a, b) => Number(b.parts[0].pr) - Number(a.parts[0].pr));
  if (!rows.length) return null;
  const prCount = rows.filter((r) => r.parts[0].pr).length;
  return (
    <>
      <div className="section-title">{prCount ? plural(prCount, 'record', 'records') : 'Progress'}</div>
      <div className="sum-hl sum-in" style={{ '--i': 1 } as CSSProperties}>
        {rows.map(({ e, parts }) => (
          <div key={e.exerciseId} className="sum-hl-row">
            <span className={'sum-hl-icon' + (parts[0].pr ? ' pr' : '')} aria-hidden><Icon name={parts[0].pr ? 'bolt' : 'chevronUp'} size={18} stroke={2.4} /></span>
            <span className="grow">
              <span className="sum-hl-title ellipsis">{e.exercise}</span>
              <span className="sum-hl-sub">{parts.map((p) => p.text).join(' · ')}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

const TREND = {
  up: { sym: '↑', label: 'beat last time', cls: 'up' },
  same: { sym: '=', label: 'same as last time', cls: 'same' },
  down: { sym: '↓', label: 'below last time', cls: 'down' },
  new: { sym: 'New', label: 'first time', cls: 'new' },
} as const;

function ExerciseRow({ e, unit }: { e: Ex; unit: Unit }) {
  const t = TREND[e.trend];
  const b = e.bestSet;
  return (
    <div className="list-item">
      <span className="grow">
        <span className="title ellipsis" style={{ display: 'block' }}>{e.exercise}</span>
        <span className="sub num" style={{ display: 'block' }}>
          {plural(e.sets, 'set', 'sets')}
          {b && ` · ${loadText(e.loadType, b.loadKg, unit)} × ${b.reps}`}{b?.e1rmKg != null && ` · est. 1RM ${b.e1rmReliable ? '' : '≈'}${fmtWeight(half(b.e1rmKg), unit)}`}
          {e.bodyweight === 'missing' && ' · no weigh-in'}
        </span>
      </span>
      <span className={'sum-trend ' + t.cls} role="img" aria-label={t.label} title={t.label}>{t.sym}</span>
    </div>
  );
}

function MuscleBars({ data }: { data: WorkoutSummaryData }) {
  const max = Math.max(1, ...data.muscles.map((m) => m.week.fractional));
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <>
      <div className="section-title">Sets per muscle</div>
      <div className="card sum-in sum-muscles" style={{ '--i': 3 } as CSSProperties}>
        {data.muscles.map((m) => (
          <div key={m.muscle} className="sum-m-row">
            <span className="sum-m-name ellipsis">{titleCase(m.muscle)}</span>
            <span className="sum-m-bar" aria-hidden>
              <span className="wk" style={{ width: `${(m.week.fractional / max) * 100}%` }} />
              <span className="now" style={{ width: `${(m.fractional / max) * 100}%` }} />
            </span>
            <span className="sum-m-num num" aria-label={`${n(m.fractional)} sets today, ${n(m.week.fractional)} this week`}>
              {n(m.fractional)}<span className="faint"> / {n(m.week.fractional)}</span>
            </span>
          </div>
        ))}
        <p className="faint sum-caption" style={{ margin: '10px 0 0', textAlign: 'left' }}>
          Today / this week (since Mon). Secondary muscles count ½ a set, a common convention.
        </p>
      </div>
    </>
  );
}

function Survey({ data }: { data: WorkoutSummaryData }) {
  const s = data.survey;
  const rate = (p: Omit<z.input<typeof sessionsRate.input>, 'id'>) => run(sessionsRate, { id: data.sessionId, ...p });
  return (
    <>
      <div className="section-title">How was it?</div>
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
          <textarea key={data.sessionId} aria-label="Note" className="input" rows={2} style={{ padding: 12, resize: 'vertical' }} defaultValue={s.note ?? ''}
            placeholder="Optional" onBlur={(e) => { if ((e.target.value || null) !== (s.note ?? null)) rate({ note: e.target.value || null }); }} />
        </label>
      </div>
      <p className="faint sum-caption">All optional. Saved as you tap.</p>
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
