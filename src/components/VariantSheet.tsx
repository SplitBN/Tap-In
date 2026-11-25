// Variant chooser (grip / width / attachment), modelled on Alpha Progression: your variants on top for one tap, then one
// chip row per axis starting on the base exercise. Confirm → exercises.variant (get or create) → onPick with the record.
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { run } from '../api/registry';
import { exercisesFamily, exercisesVariant } from '../api/gym';
import type { Exercise } from '../db/types';
import { equipmentTag } from '../lib/equipment';
import { plural } from '../lib/format';
import { AXIS_LABEL, CHIP, composeName, FAMILIES, groupOf, normalizeVariant, optionsOf, variantKey, withAxis, type Axis, type Variant } from '../lib/variants';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

export function VariantSheet({ open, onClose, exercise, onPick, confirm = 'Add', title }: {
  open: boolean; onClose: () => void; exercise?: Exercise; onPick: (ex: Exercise) => void | Promise<void>;
  /** confirm button label ("Add", "Swap") */
  confirm?: string; title?: string;
}) {
  const g = groupOf(exercise);
  const famRaw = useLiveQuery(async () => (open && exercise && g ? run(exercisesFamily, { exerciseId: exercise.id }) : null), [open, exercise?.id]);
  // the chip selection belongs to one exercise; it starts on the one the sheet was opened for (the base in the picker,
  // the current variant in a session) and never leaks into the next family opened
  const [sel, setSel] = useState<{ id?: string; v: Variant }>({ v: {} });
  const [busy, setBusy] = useState(false);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (!open) setSel({ v: {} }); }
  if (!exercise || !g) return null;
  // ignore a family result still loading for the previously opened exercise
  const fam = famRaw && famRaw.family === exercise.family && famRaw.equipment === exercise.equipment ? famRaw : null;

  const current = normalizeVariant(g, sel.id === exercise.id ? sel.v : exercise.variant);
  const key = variantKey(g, current);
  const baseName = fam?.baseName ?? FAMILIES[exercise.family!]?.name ?? exercise.name;
  const match = fam?.members.find((m) => variantKey(g, m.variant ?? undefined) === key);
  const name = match?.name ?? composeName(fam?.members.find((m) => !m.variant)?.name ?? baseName, exercise.family!, g, current);
  const tag = equipmentTag({ name: baseName, equipment: exercise.equipment });
  // your variants: done ones first (most sessions), then other existing ones (seeded or created); the base is one of them
  const mine = [...(fam?.members ?? [])].sort((a, b) => b.sessions - a.sessions || Number(!!a.variant) - Number(!!b.variant));

  const pick = async (v: Variant) => {
    if (busy) return;
    setBusy(true);
    try { const rec = await run(exercisesVariant, { exerciseId: exercise.id, ...v }); await onPick(rec); onClose(); }
    finally { setBusy(false); }
  };
  const choose = (axis: Axis, value: string) => setSel({ id: exercise.id, v: withAxis(g, current, axis, value) });

  return (
    <Sheet open={open} onClose={onClose} title={title ?? <>{baseName}{tag && <span className="eq"> · {tag}</span>}</>}>
      <div className="stack" style={{ gap: 16 }}>
        {mine.length > 1 && (
          <div className="group" role="group" aria-label="Your variants">
            {mine.map((m) => {
              const on = m.id === match?.id;
              return (
                <button key={m.id} className="am-row pressable" aria-pressed={on} onClick={() => pick(m.selection)}>
                  <Icon name={m.sessions ? 'history' : 'layers'} />
                  <span className="grow ellipsis">{m.text || 'Standard'}
                    {m.sessions > 0 && <span className="am-sub num">{plural(m.sessions, 'session', 'sessions')}</span>}
                  </span>
                  {on && <Icon name="check" size={20} stroke={2.6} className="role-text" />}
                </button>
              );
            })}
          </div>
        )}

        {g.axes.map((axis) => (
          <div key={axis} className="field">
            <span id={`vx-${axis}`}>{AXIS_LABEL[axis]}</span>
            <div className="chips" role="group" aria-labelledby={`vx-${axis}`} style={{ flexWrap: 'wrap' }}>
              {optionsOf(g, axis).map((o) => (
                <button key={o} className="chip" aria-pressed={current[axis] === o} onClick={() => choose(axis, o)}>
                  {CHIP[o]}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="row" style={{ gap: 10, padding: '0 6px' }}>
          <span className="grow ellipsis" style={{ fontWeight: 600 }}>{name}</span>
          {!match && <span className="badge accent">New</span>}
        </div>
        <button className="btn primary lg block" disabled={busy} onClick={() => pick(current)}>{confirm}</button>
      </div>
    </Sheet>
  );
}
