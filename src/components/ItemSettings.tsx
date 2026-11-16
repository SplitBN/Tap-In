import type { ReactNode } from 'react';
import type { WorkoutItem } from '../db/types';
import { Icon } from './Icon';

/** − value + control. `label` names what it changes ("Compound rest"); the buttons say "Decrease compound rest" /
 *  "Increase compound rest" unless `less` / `more` give better words ("Remove set" / "Add set"). The value is announced. */
export function Stepper({ value, onChange, min = 0, max = 99, step = 1, format, label, less, more }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; format?: (v: number) => ReactNode;
  label: string; less?: string; more?: string;
}) {
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  return (
    <div className="row" style={{ gap: 4 }} role="group" aria-label={label}>
      <button className="icon-btn filled" aria-label={less ?? `Decrease ${lower}`} onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min}><Icon name="minus" size={18} /></button>
      <span className="num t-17" style={{ minWidth: 56, textAlign: 'center', fontWeight: 650 }} aria-live="polite">{format ? format(value) : value}</span>
      <button className="icon-btn filled" aria-label={more ?? `Increase ${lower}`} onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max}><Icon name="plus" size={18} /></button>
    </div>
  );
}

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
