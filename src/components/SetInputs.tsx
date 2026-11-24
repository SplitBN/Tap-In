import { useMemo } from 'react';
import { run } from '../api/registry';
import { exercisesUpdate } from '../api/gym';
import { settingsUpdate } from '../api/body';
import type { EffortMode, Exercise, Unit } from '../db/types';
import { WEIGHT_STEPS as STEPS, defaultStepKg, fromKg, stepInUnit, toKg } from '../lib/science';
import { fmtNum } from '../lib/format';
import { Sheet } from './Sheet';
import { Icon } from './Icon';
import { NumberSheet, type NumberSpec } from './NumberPicker';


/** Weight entry: tap list stepping by the exercise's increment (in the current unit) + keypad.
 *  Unit and increment can be switched right here (unit is app-wide; stored values stay kg). */
export function WeightSheet({ open, onClose, valueKg, onDone, unit, exercise, label }: {
  open: boolean; onClose: () => void; valueKg: number | null | undefined; onDone: (kg: number | null) => void;
  unit: Unit; exercise?: Exercise; label: string;
}) {
  const stepKg = exercise?.stepKg ?? defaultStepKg(exercise?.equipment ?? 'other', unit);
  const stepU = stepInUnit(stepKg, unit); // standard step in this unit, so 5 lb ↔ 2.5 kg round-trips
  const curKg = valueKg ?? (exercise?.equipment === 'barbell' ? 20 : 0);
  const cur = Math.round(fromKg(curKg, unit) * 100) / 100;
  const spec = useMemo<NumberSpec>(() => ({
    min: 0, max: unit === 'kg' ? 400 : 900, step: stepU, decimals: 2, unit, keyMax: unit === 'kg' ? 1000 : 2200,
  }), [unit, stepU]);

  const setStep = (s: number) => exercise && run(exercisesUpdate, { id: exercise.id, stepKg: toKg(s, unit) });
  const setUnit = (u: Unit) => { if (u !== unit) run(settingsUpdate, { unit: u }); };
  // the highlighted off-grid row (e.g. 60 kg shown as 132.28 lb) gives back the exact stored kg
  const pick = (v: number) => onDone(Math.abs(v - cur) < 1e-9 && valueKg != null ? valueKg : toKg(v, unit));

  return (
    <NumberSheet open={open} onClose={onClose} title={label} value={cur} onPick={pick} spec={spec}
      extra={
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="Unit" style={{ width: 112, flex: 'none' }}>
            {(['kg', 'lb'] as const).map((u) => <button key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>)}
          </div>
          {/* scrolls from its start (a flex-end scroller clips the first chips); auto margin right-aligns it when it fits */}
          <div className="chips grow" role="group" aria-label="Step">
            <span className="faint w-6 t-13" aria-hidden style={{ marginLeft: 'auto', alignSelf: 'center', paddingRight: 2 }}>±</span>
            {STEPS[unit].map((s) => <button key={s} className="chip" aria-pressed={s === stepU} aria-label={`Step ${fmtNum(s)} ${unit}`} onClick={() => setStep(s)}>{fmtNum(s)}</button>)}
          </div>
        </div>
      }
      footer={valueKg != null && (
        <button className="btn block" onClick={() => { onDone(null); onClose(); }} style={{ color: 'var(--text-2)' }}><Icon name="close" size={16} /> Clear</button>
      )}
    />
  );
}

/** Reps entry: 0–100 tap list + keypad. Same contract as WeightSheet (null = clear). */
export function RepsSheet({ open, onClose, value, onDone, label = 'Reps' }: {
  open: boolean; onClose: () => void; value: number | null | undefined; onDone: (reps: number | null) => void; label?: string;
}) {
  return (
    <NumberSheet open={open} onClose={onClose} title={label} value={value ?? null} onPick={(v) => onDone(Math.round(v))}
      spec={REPS_SPEC}
      footer={value != null && (
        <button className="btn block" onClick={() => { onDone(null); onClose(); }} style={{ color: 'var(--text-2)' }}><Icon name="close" size={16} /> Clear</button>
      )}
    />
  );
}
const REPS_SPEC: NumberSpec = { min: 0, max: 100, step: 1, decimals: 0, keyMax: 999 };

export function EffortSheet({ open, onClose, mode, value, onDone }: {
  open: boolean; onClose: () => void; mode: EffortMode; value: number | null | undefined; onDone: (v: number | null, mode: EffortMode) => void;
}) {
  const opts = mode === 'rir' ? range(0, 5, 0.5) : range(5, 10, 0.5);
  return (
    <Sheet open={open} onClose={onClose} title={mode === 'rir' ? 'Reps in reserve' : 'RPE'}>
      <div className="stack" style={{ gap: 14 }}>
        <EffortExplainer mode={mode} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {opts.map((v) => (
            <button key={v} className={'btn num' + (value === v ? ' primary' : '')} aria-pressed={value === v}
              onClick={() => { onDone(v, mode); onClose(); }}>{fmtNum(v)}{mode === 'rir' && v === 5 ? '+' : ''}</button>
          ))}
          <button className="btn" onClick={() => { onDone(null, mode); onClose(); }}>Clear</button>
        </div>
      </div>
    </Sheet>
  );
}

/** What RIR / RPE mean, with the switch between them (the set table's column header opens this too). */
export function EffortExplainer({ mode }: { mode: EffortMode }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="seg" role="group" aria-label="Effort scale">
        {(['rir', 'rpe'] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => run(settingsUpdate, { effortMode: m })}>{m.toUpperCase()}</button>)}
      </div>
      <p className="muted t-15" style={{ margin: 0, lineHeight: 1.45 }}>
        {mode === 'rir'
          ? 'Reps in reserve: how many more reps you could have done. 0 = failure, 2 = two left in the tank.'
          : 'RPE on the reps-in-reserve scale: 10 = failure, 9.5 = no more reps but a little more weight, 9 = one rep left, 8 = two, 7 = three, 5–6 = about 4–6 left.'}
      </p>
    </div>
  );
}

const range = (a: number, b: number, s: number) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => a + i * s);
