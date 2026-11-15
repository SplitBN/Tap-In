import { useMemo, useState } from 'react';
import { save } from '../db/db';
import { updateSettings } from '../db/settings';
import type { EffortMode, Exercise, Unit } from '../db/types';
import { defaultStepKg, fromKg, toKg } from '../lib/science';
import { fmtNum, fmtWeight } from '../lib/format';
import { Sheet } from './Sheet';
import { Icon } from './Icon';
import { Wheel } from './Wheel';

const STEPS: Record<Unit, number[]> = { kg: [0.5, 1, 1.25, 2, 2.5, 5], lb: [1, 2.5, 5, 10] };

/** Big weight wheel. Unit can be switched right here (changes the app-wide unit; stored values stay kg). */
export function WeightSheet({ open, onClose, valueKg, onDone, unit, exercise, label }: {
  open: boolean; onClose: () => void; valueKg: number | null | undefined; onDone: (kg: number | null) => void;
  unit: Unit; exercise?: Exercise; label: string;
}) {
  const stepKg = exercise?.stepKg ?? defaultStepKg(exercise?.equipment ?? 'other', unit);
  const stepU = closest(STEPS[unit], fromKg(stepKg, unit));
  const values = useMemo(() => {
    const max = unit === 'kg' ? 400 : 900;
    const out: number[] = [];
    for (let v = 0; v <= max + 1e-9; v += stepU) out.push(Math.round(v * 100) / 100);
    return out;
  }, [unit, stepU]);
  const [cur, setCur] = useState<number>(0);
  const [was, setWas] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  if (open !== was) { setWas(open); if (open) { setCur(fromKg(valueKg ?? (exercise?.equipment === 'barbell' ? 20 : 0), unit)); setTyped(null); } }
  const index = nearestIndex(values, cur);
  const typedNum = typed != null && typed.trim() !== '' ? parseFloat(typed) : NaN;
  const final = Number.isFinite(typedNum) ? typedNum : values[index];

  const setStep = (s: number) => exercise && save('exercises', { ...exercise, stepKg: toKg(s, unit) });
  const setUnit = (u: Unit) => { if (u === unit) return; setCur(fromKg(toKg(cur, unit), u)); updateSettings({ unit: u }); };

  return (
    <Sheet open={open} onClose={onClose} title={label}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="seg" role="group" aria-label="Unit">
          {(['kg', 'lb'] as const).map((u) => <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>)}
        </div>
        <Wheel values={values} index={index} onIndex={(i) => { setCur(values[i]); setTyped(null); }} format={(v) => fmtNum(v)} ariaLabel={`${label} in ${unit}`} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="faint" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>±</span>
          <div className="chips">
            {STEPS[unit].map((s) => <button key={s} className="chip" aria-pressed={s === stepU} onClick={() => setStep(s)}>{fmtNum(s)}</button>)}
          </div>
        </div>
        <div className="row">
          <button className="icon-btn filled" aria-label="Clear" onClick={() => { onDone(null); onClose(); }} style={{ color: 'var(--text-2)' }}><Icon name="close" size={18} /></button>
          {/* exact entry: type any value (e.g. 23.75) — overrides the wheel */}
          <input className="input num" inputMode="decimal" aria-label={`Type ${label.toLowerCase()}`} placeholder={fmtNum(values[index])}
            value={typed ?? ''} onChange={(e) => setTyped(e.target.value.replace(',', '.'))}
            style={{ width: 96, textAlign: 'center', borderRadius: 999, fontWeight: 700, fontSize: '1.125rem' }} />
          <button className="btn primary grow lg" onClick={() => { onDone(toKg(final, unit)); onClose(); }} disabled={!(final >= 0)}>
            <Icon name="check" size={20} stroke={2.6} /> {fmtWeight(toKg(final, unit), unit)}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function EffortSheet({ open, onClose, mode, value, onDone }: {
  open: boolean; onClose: () => void; mode: EffortMode; value: number | null | undefined; onDone: (v: number | null, mode: EffortMode) => void;
}) {
  const opts = mode === 'rir' ? range(0, 5, 0.5) : range(5, 10, 0.5);
  return (
    <Sheet open={open} onClose={onClose} title={mode === 'rir' ? 'Reps in reserve' : 'RPE'}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="seg">
          {(['rir', 'rpe'] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => updateSettings({ effortMode: m })}>{m.toUpperCase()}</button>)}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: '0.875rem' }}>
          {mode === 'rir' ? 'How many more reps could you have done? 0 = failure.' : 'Effort out of 10. RPE 10 = failure, 9 = one rep left.'}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {opts.map((v) => (
            <button key={v} className="btn num" aria-pressed={value === v}
              style={value === v ? { background: 'var(--accent)', color: 'var(--accent-text)' } : undefined}
              onClick={() => { onDone(v, mode); onClose(); }}>{fmtNum(v)}{mode === 'rir' && v === 5 ? '+' : ''}</button>
          ))}
          <button className="btn" onClick={() => { onDone(null, mode); onClose(); }}>Clear</button>
        </div>
      </div>
    </Sheet>
  );
}

const range = (a: number, b: number, s: number) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => a + i * s);
const closest = (arr: number[], v: number) => arr.reduce((p, c) => (Math.abs(c - v) < Math.abs(p - v) ? c : p));
const nearestIndex = (arr: number[], v: number) => {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
  return best;
};
