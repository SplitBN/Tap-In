import type { ReactNode } from 'react';
import type { Exercise, Settings, WorkoutItem } from '../db/types';
import { defaultRestSec } from '../lib/science';
import { fmtDuration } from '../lib/format';
import { Icon } from './Icon';

export function Stepper({ value, onChange, min = 0, max = 99, step = 1, format, label = "" }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; format?: (v: number) => ReactNode; label?: string;
}) {
  return (
    <div className="row" style={{ gap: 4 }}>
      <button className="icon-btn filled" aria-label={`Less ${label}`.trim()} onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min}><Icon name="minus" size={18} /></button>
      <span className="num" style={{ minWidth: 56, textAlign: 'center', fontWeight: 650, fontSize: '1.0625rem' }}>{format ? format(value) : value}</span>
      <button className="icon-btn filled" aria-label={`More ${label}`.trim()} onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max}><Icon name="plus" size={18} /></button>
    </div>
  );
}

function Line({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <div className="row" style={{ minHeight: 56, padding: '6px 0' }}>
      <span className="grow"><span style={{ fontWeight: 560 }}>{label}</span>{sub && <><br /><span className="muted" style={{ fontSize: '0.8125rem' }}>{sub}</span></>}</span>
      {children}
    </div>
  );
}

/** Edits one exercise slot. Used by the plan editor and mid-workout (same controls, per the spec). */
export function ItemSettings({ item, exercise, settings, onChange }: {
  item: WorkoutItem; exercise?: Exercise; settings: Settings; onChange: (i: WorkoutItem) => void;
}) {
  const def = exercise ? defaultRestSec(exercise.mechanic, settings.restCompoundSec, settings.restIsolationSec) : 120;
  const restSec = item.rest.sec ?? def;
  const hasRange = item.repsMin != null;
  return (
    <div className="stack" style={{ gap: 0 }}>
      <Line label="Working sets"><Stepper label="Working sets" value={item.sets} min={1} max={20} onChange={(sets) => onChange({ ...item, sets })} /></Line>
      {settings.features.warmups && (
        <Line label="Warm-up sets" sub="Not counted in progress"><Stepper label="Warm-up sets" value={item.warmups ?? 0} max={6} onChange={(warmups) => onChange({ ...item, warmups })} /></Line>
      )}
      <Line label="Target reps" sub={hasRange ? undefined : 'Optional'}>
        {hasRange ? (
          <div className="row" style={{ gap: 6 }}>
            <input className="input num" style={{ width: 64, textAlign: 'center' }} inputMode="numeric" aria-label="Min reps"
              value={item.repsMin ?? ''} onChange={(e) => onChange({ ...item, repsMin: num(e.target.value) })} />
            <span className="faint">–</span>
            <input className="input num" style={{ width: 64, textAlign: 'center' }} inputMode="numeric" aria-label="Max reps"
              value={item.repsMax ?? ''} onChange={(e) => onChange({ ...item, repsMax: num(e.target.value) })} />
            <button className="icon-btn" aria-label="Remove target" onClick={() => onChange({ ...item, repsMin: undefined, repsMax: undefined })}><Icon name="close" size={18} /></button>
          </div>
        ) : <button className="btn" onClick={() => onChange({ ...item, repsMin: 8, repsMax: 12 })}>Set</button>}
      </Line>
      <Line label="Drop sets" sub="Drops after each working set, −20% each"><Stepper label="Drop sets" value={item.drops ?? 0} max={4} onChange={(drops) => onChange({ ...item, drops })} /></Line>
      {settings.features.restTimer && (
        <>
          <Line label="Rest">
            <div className="seg" style={{ width: 170 }}>
              <button aria-pressed={item.rest.mode === 'timer'} onClick={() => onChange({ ...item, rest: { ...item.rest, mode: 'timer' } })}>Timer</button>
              <button aria-pressed={item.rest.mode === 'countup'} onClick={() => onChange({ ...item, rest: { ...item.rest, mode: 'countup' } })}>Count up</button>
            </div>
          </Line>
          {item.rest.mode === 'timer' && (
            <Line label="Rest time" sub={item.rest.sec == null ? `Default for ${exercise?.mechanic ?? 'this'} exercises` : undefined}>
              <Stepper value={restSec} min={15} max={600} step={15} format={(v) => fmtDuration(v * 1000)} onChange={(sec) => onChange({ ...item, rest: { ...item.rest, sec } })} />
            </Line>
          )}
        </>
      )}
      <label className="field" style={{ marginTop: 8 }}><span>Notes</span>
        <textarea className="input" rows={2} style={{ padding: 12, minHeight: 64, resize: 'vertical' }} value={item.notes ?? ''}
          placeholder="Seat height, grip, cues…" onChange={(e) => onChange({ ...item, notes: e.target.value || undefined })} />
      </label>
    </div>
  );
}

const num = (s: string) => (s.trim() === '' ? undefined : Math.max(0, parseInt(s, 10) || 0));

/** Toggle a superset between item i and the next item. */
export function toggleSupersetWithNext(items: WorkoutItem[], i: number): WorkoutItem[] {
  const a = items[i], b = items[i + 1];
  if (!a || !b) return items;
  const next = items.map((x) => ({ ...x }));
  if (a.supersetId && a.supersetId === b.supersetId) {
    // split the group at this boundary: everything after i gets a new id (or none if alone)
    const old = a.supersetId;
    const tailId = crypto.randomUUID();
    for (let j = i + 1; j < next.length && next[j].supersetId === old; j++) next[j].supersetId = tailId;
    return normalizeSupersets(next);
  }
  const id = a.supersetId ?? b.supersetId ?? crypto.randomUUID();
  const bOld = b.supersetId;
  next[i].supersetId = id;
  for (let j = i + 1; j < next.length && (j === i + 1 || (bOld && next[j].supersetId === bOld)); j++) next[j].supersetId = id;
  return normalizeSupersets(next);
}

/** Groups must be contiguous and have ≥ 2 members. */
export function normalizeSupersets(items: WorkoutItem[]): WorkoutItem[] {
  const out = items.map((x) => ({ ...x }));
  for (let i = 0; i < out.length; i++) {
    const id = out[i].supersetId;
    if (!id) continue;
    const prevSame = i > 0 && out[i - 1].supersetId === id;
    const nextSame = i < out.length - 1 && out[i + 1].supersetId === id;
    if (!prevSame && !nextSame) out[i].supersetId = undefined;
  }
  // split non-contiguous duplicates
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const id = out[i].supersetId;
    if (!id) continue;
    if (i > 0 && out[i - 1].supersetId === id) continue;
    if (seen.has(id)) {
      const nid = crypto.randomUUID();
      for (let j = i; j < out.length && out[j].supersetId === id; j++) out[j].supersetId = nid;
    } else seen.add(id);
  }
  return out;
}
