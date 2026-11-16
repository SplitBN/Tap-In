import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { Wheel } from '../components/Wheel';
import { alive, db } from '../db/db';
import { run } from '../api/registry';
import { weightDelete, weightLog, weightUpdate } from '../api/body';
import { useSettings } from '../db/settings';
import type { BodyweightEntry } from '../db/types';
import { fmtDate, fmtWeight } from '../lib/format';
import { fromKg, toKg } from '../lib/science';

export function WeightPage() {
  const settings = useSettings();
  const entries = useLiveQuery(() => db.bodyweight.orderBy('at').reverse().filter(alive).toArray(), []) ?? [];
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<BodyweightEntry>();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Weight</h1>
        <button className="icon-btn filled" aria-label="Log weight" onClick={() => { setEdit(undefined); setOpen(true); }}><Icon name="plus" /></button>
      </header>
      {entries.length ? (
        <>
          <Sparkline entries={entries} unit={settings.unit} />
          <div className="list" style={{ marginTop: 12 }}>
            {entries.map((e, i) => {
              const prev = entries[i + 1];
              const d = prev ? fromKg(e.kg - prev.kg, settings.unit) : null;
              return (
                <button key={e.id} className="list-item pressable" onClick={() => { setEdit(e); setOpen(true); }}>
                  <span className="grow">
                    <span className="title num">{fmtWeight(e.kg, settings.unit)}</span>
                    <span className="sub" style={{ display: 'block' }}>{fmtDate(e.at)} · {new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                  </span>
                  {d != null && <span className="num" style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>{d > 0 ? '+' : ''}{d.toFixed(1)}</span>}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty"><Icon name="scale" size={40} /><h3>No weigh-ins yet</h3><p>Weigh in at the same time of day for the cleanest trend.</p>
          <button className="btn primary" onClick={() => setOpen(true)}>Log weight</button></div>
      )}
      <WeighInSheet open={open} onClose={() => setOpen(false)} entry={edit} />
    </div>
  );
}

function Sparkline({ entries, unit }: { entries: BodyweightEntry[]; unit: 'kg' | 'lb' }) {
  const pts = entries.slice(0, 60).reverse();
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.kg);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const W = 300, H = 80;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at, tspan = t1 - t0 || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((p.at - t0) / tspan) * W},${H - 6 - ((p.kg - min) / span) * (H - 12)}`).join(' ');
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="grow muted" style={{ fontSize: '0.8125rem' }}>Last {pts.length} weigh-ins</span>
        <span className="num muted" style={{ fontSize: '0.8125rem' }}>{fmtWeight(min, unit)} – {fmtWeight(max, unit)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Weight over time">
        <path d={d} fill="none" stroke="var(--warn)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function WeighInSheet({ open, onClose, entry }: { open: boolean; onClose: () => void; entry?: BodyweightEntry }) {
  const settings = useSettings();
  const unit = settings.unit;
  const last = useLiveQuery(() => db.bodyweight.orderBy('at').reverse().filter(alive).first(), []);
  const values = useMemo(() => {
    const out: number[] = [];
    const [lo, hi] = unit === 'kg' ? [30, 250] : [66, 550];
    for (let v = lo * 10; v <= hi * 10; v += 1) out.push(v / 10);
    return out;
  }, [unit]);
  const [cur, setCur] = useState(0);
  const [when, setWhen] = useState('');
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setCur(Math.round(fromKg(entry?.kg ?? last?.kg ?? 80, unit) * 10) / 10);
      setWhen(toLocalInput(entry?.at ?? Date.now()));
    }
  }
  const idx = Math.max(0, values.findIndex((v) => Math.abs(v - cur) < 0.05));
  const submit = async () => {
    const at = new Date(new Date(when).getTime() || Date.now()).toISOString();
    const kg = toKg(values[idx], unit);
    if (entry) await run(weightUpdate, { id: entry.id, kg, at });
    else await run(weightLog, { kg, at });
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={entry ? 'Edit weigh-in' : 'Log weight'}>
      <div className="stack" style={{ gap: 14 }}>
        <Wheel values={values} index={idx} onIndex={(i) => setCur(values[i])} format={(v) => v.toFixed(1)} ariaLabel={`Bodyweight in ${unit}`} />
        <label className="field"><span>When</span>
          <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <button className="btn primary lg block" onClick={submit}>Save {values[idx].toFixed(1)} {unit}</button>
        {entry && <button className="btn danger block" onClick={async () => { await run(weightDelete, { id: entry.id }); onClose(); }}>Delete</button>}
      </div>
    </Sheet>
  );
}

function toLocalInput(ts: number) {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
