import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { confirmDialog, notice } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { NumberField, NumberRow, doseSpec, type NumberSpec } from '../components/NumberPicker';
import { PickerRow } from '../components/Picker';
import { Sheet } from '../components/Sheet';
import { alive, db } from '../db/db';
import { FORMS, SITES, UNITS, WEEKDAYS, buildDay, doseOn, nextSite, scheduleText, type DueItem } from '../db/supps';
import type { DoseStep, SchedKind, Schedule, Stack, SuppForm, SuppLog, Supplement } from '../db/types';
import { run } from '../api/registry';
import { notesAdd, notesDelete, stackDelete, stackSave, suppDelete, suppSave, suppTake, suppUnlog } from '../api/body';
import { fmtNum } from '../lib/format';
import { dateKey, keyToDate, shiftDate } from '../lib/nutrition';
import { Ring } from './Food';

const slotName = (slot: string) => {
  if (slot === '--:--') return 'Any time';
  const h = +slot.slice(0, 2);
  return h < 11 ? 'Morning' : h < 15 ? 'Midday' : h < 18 ? 'Afternoon' : h < 22 ? 'Evening' : 'Night';
};

export function useSuppDay(date: string) {
  const sups = useLiveQuery(() => db.supplements.filter(alive).sortBy('name'), []) ?? [];
  const stacks = useLiveQuery(() => db.stacks.filter(alive).toArray(), []) ?? [];
  const logs = useLiveQuery(() => db.supplogs.where('date').equals(date).filter(alive).toArray(), [date]) ?? [];
  const day = buildDay(date, sups, stacks, logs);
  const items = day.flatMap((g) => g.stacks.flatMap((s) => s.items));
  return { sups, stacks, logs, day, done: items.filter((i) => i.log?.status === 'taken').length, total: items.length };
}

export function SupplementsPage() {
  const [params, setParams] = useSearchParams();
  const today = dateKey();
  const date = params.get('d') ?? today;
  const setDate = (d: string) => setParams(d === today ? {} : { d }, { replace: true });
  const { sups, stacks, logs, day, done, total } = useSuppDay(date);
  const notes = useLiveQuery(() => db.notes.orderBy('at').reverse().filter(alive).limit(5).toArray(), []) ?? [];
  const [taking, setTaking] = useState<{ sup: Supplement; slot: string | null; log?: SuppLog } | null>(null);
  const [editing, setEditing] = useState<Supplement | 'new' | null>(null);
  const [stackEdit, setStackEdit] = useState<Stack | 'new' | null>(null);
  const [noting, setNoting] = useState(false);
  const asNeeded = sups.filter((s) => !s.archived && s.schedule.kind === 'asNeeded');
  const asNeededLogs = logs.filter((l) => l.slot == null && l.status === 'taken');
  const label = date === today ? 'Today' : date === shiftDate(today, -1) ? 'Yesterday' : keyToDate(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  // the command fills in the time (now, or the scheduled time when back-filling) and rotates injection sites
  const quickToggle = async (d: DueItem) => {
    if (d.log) { await run(suppUnlog, { logId: d.log.id }); return; }
    await run(suppTake, { supplementId: d.sup.id, date, time: d.slot === '--:--' ? null : d.slot, amount: d.amount });
  };
  const takeAll = async (items: DueItem[]) => {
    const open = items.filter((i) => !i.log);
    if (!open.length) { for (const i of items) await run(suppUnlog, { logId: i.log!.id }); return; }
    for (const i of open) await quickToggle(i);
  };

  return (
    <div className="page" data-role="supp">
      <header className="page-head">
        <h1>Supps</h1>
        <button className="icon-btn" aria-label="Add a note" onClick={() => setNoting(true)}><Icon name="note" /></button>
        <button className="icon-btn filled" aria-label="New supplement" onClick={() => setEditing('new')}><Icon name="plus" /></button>
      </header>

      <div className="date-pill">
        <button className="icon-btn sm" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}><Icon name="chevronLeft" size={18} /></button>
        <button className="date-pill-label" onClick={() => setDate(today)}><Icon name="calendar" size={16} />{label}</button>
        <button className="icon-btn sm" aria-label="Next day" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today}><Icon name="chevronRight" size={18} /></button>
      </div>

      {!sups.length ? (
        <div className="empty">
          <Icon name="pill" size={40} />
          <h3>Nothing tracked yet</h3>
          <p>Add a supplement, medication or peptide with its dose and schedule.</p>
          <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={18} /> Supplement</button>
        </div>
      ) : (
        <>
          {total > 0 && (
            <div className="card row" style={{ marginTop: 12, gap: 16 }}>
              <Ring value={done} max={total} size={64}><span className="num" style={{ fontWeight: 800 }}>{done}/{total}</span></Ring>
              <div className="grow">
                <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{done === total ? 'All taken' : `${total - done} to go`}</div>
                <div className="muted" style={{ fontSize: '0.8125rem' }}>Tap ✓ to log at the scheduled dose · tap a row to adjust</div>
              </div>
            </div>
          )}

          {day.map((g) => (
            <section key={g.slot} className="card slot-card">
              <div className="slot-head"><span className="num">{g.slot === '--:--' ? '' : g.slot}</span> {slotName(g.slot)}</div>
              {g.stacks.map(({ stack, items }) => (
                <div key={(stack?.id ?? '') + items[0].sup.id} className={stack ? 'stack-box' : ''}>
                  {stack && (
                    <div className="row stack-head">
                      <Icon name="link" size={14} stroke={2.2} />
                      <span className="grow">{stack.name}</span>
                      <button className={'check' + (items.every((i) => i.log?.status === 'taken') ? ' on' : '')} aria-label={`Take all of ${stack.name}`} onClick={() => takeAll(items)}>
                        <Icon name="check" size={18} stroke={2.8} /><span className="sr-only">all</span>
                      </button>
                    </div>
                  )}
                  {items.map((d) => (
                    <div key={d.sup.id + d.slot} className="supp-row">
                      <button className="grow supp-main pressable" onClick={() => setTaking({ sup: d.sup, slot: d.slot === '--:--' ? null : d.slot, log: d.log })}>
                        <span className="supp-name" dir="auto">{d.sup.name}</span>
                        <span className="supp-sub num">
                          {fmtNum(d.log?.amount ?? d.amount)} {d.sup.unit}
                          {d.log?.status === 'taken' && d.log.takenAt ? ` · ${new Date(d.log.takenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}
                          {d.log?.site ? ` · ${d.log.site}` : ''}
                          {d.log?.status === 'skipped' ? ' · skipped' : ''}
                        </span>
                      </button>
                      <button className={'check' + (d.log?.status === 'taken' ? ' on' : d.log?.status === 'skipped' ? ' skipped' : '')}
                        aria-pressed={d.log?.status === 'taken'} aria-label={d.log ? `Undo ${d.sup.name}` : `Take ${d.sup.name}`} onClick={() => quickToggle(d)}>
                        <Icon name={d.log?.status === 'skipped' ? 'close' : 'check'} size={18} stroke={2.8} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}

          {asNeeded.length > 0 && (
            <section className="card slot-card">
              <div className="slot-head">As needed</div>
              {asNeeded.map((s) => {
                const n = asNeededLogs.filter((l) => l.supplementId === s.id);
                return (
                  <div key={s.id} className="supp-row">
                    <button className="grow supp-main pressable" onClick={() => setEditing(s)}>
                      <span className="supp-name" dir="auto">{s.name}</span>
                      <span className="supp-sub num">{fmtNum(doseOn(s, date))} {s.unit}{n.length ? ` · ${n.length}× today` : ''}</span>
                    </button>
                    <button className="check" aria-label={`Log ${s.name}`} onClick={() => setTaking({ sup: s, slot: null })}><Icon name="plus" size={18} stroke={2.6} /></button>
                  </div>
                );
              })}
            </section>
          )}

          <div className="section-title">All</div>
          <div className="list">
            {sups.map((s) => (
              <button key={s.id} className="list-item pressable" onClick={() => setEditing(s)} style={s.archived ? { opacity: 0.5 } : undefined}>
                <span className="role-chip"><Icon name={s.form === 'injection' ? 'syringe' : 'pill'} size={16} stroke={2} /></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="title ellipsis" dir="auto" style={{ display: 'block' }}>{s.name}</span>
                  <span className="sub">{fmtNum(doseOn(s, today))} {s.unit} · {scheduleText(s.schedule)}{s.stock != null ? ` · ${fmtNum(s.stock)} left` : ''}</span>
                </span>
                <Icon name="chevronRight" className="chev" size={18} />
              </button>
            ))}
          </div>

          <div className="section-title">Stacks</div>
          <div className="list">
            {stacks.map((st) => (
              <button key={st.id} className="list-item pressable" onClick={() => setStackEdit(st)}>
                <Icon name="link" size={18} />
                <span className="grow" style={{ minWidth: 0 }}><span className="title">{st.name}</span>
                  <span className="sub ellipsis" style={{ display: 'block' }}>{st.supplementIds.map((id) => sups.find((s) => s.id === id)?.name).filter(Boolean).join(' · ')}</span></span>
                <Icon name="chevronRight" className="chev" size={18} />
              </button>
            ))}
            <button className="list-item pressable" style={{ color: 'var(--accent)' }} onClick={() => setStackEdit('new')}><Icon name="plus" size={18} /><span className="title">Stack</span></button>
          </div>

          {notes.length > 0 && <>
            <div className="section-title">Notes</div>
            <div className="list">
              {notes.map((n) => (
                <div key={n.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <span className="grow"><span className="title" dir="auto" style={{ fontWeight: 500 }}>{n.text}</span>
                    <span className="sub" style={{ display: 'block' }}>{new Date(n.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{n.tags.includes('side-effect') ? ' · side effect' : ''}</span></span>
                  <button className="icon-btn sm" aria-label="Delete note" onClick={() => run(notesDelete, { id: n.id })}><Icon name="close" size={16} /></button>
                </div>
              ))}
            </div>
          </>}
        </>
      )}

      <TakeSheet t={taking} date={date} onClose={() => setTaking(null)} />
      <SupplementEditor open={!!editing} sup={editing === 'new' ? undefined : editing ?? undefined} onClose={() => setEditing(null)} />
      <StackEditor open={!!stackEdit} stack={stackEdit === 'new' ? undefined : stackEdit ?? undefined} sups={sups.filter((s) => !s.archived)} onClose={() => setStackEdit(null)} />
      <NoteSheet open={noting} sups={sups} onClose={() => setNoting(false)} />
    </div>
  );
}

/** Timestamp for back-filling a past day: the scheduled time on that date (noon if none). */
function stampFor(date: string, slot: string) {
  const d = keyToDate(date);
  const [h, m] = slot === '--:--' ? [12, 0] : slot.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
const toTimeInput = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* ---------------- adjust one dose: amount, time, site, skip ---------------- */
function TakeSheet({ t, date, onClose }: { t: { sup: Supplement; slot: string | null; log?: SuppLog } | null; date: string; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [time, setTime] = useState('');
  const [site, setSite] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const k = t ? `${t.sup.id}:${t.slot}:${t.log?.id ?? ''}` : null;
  if (k !== key) {
    setKey(k);
    if (t) {
      setAmount(String(t.log?.amount ?? doseOn(t.sup, date)));
      setTime(toTimeInput(t.log?.takenAt ?? (date === dateKey() ? Date.now() : stampFor(date, t.slot ?? '--:--'))));
      setSite(t.log?.site ?? null);
      if (!t.log?.site && (t.sup.route === 'subq' || t.sup.route === 'im')) nextSite(t.sup.id).then(setSite);
    }
  }
  if (!t) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const inj = t.sup.route === 'subq' || t.sup.route === 'im';
  const at = () => { const d = keyToDate(date); const [h, m] = time.split(':').map(Number); d.setHours(h || 0, m || 0, 0, 0); return d.getTime(); };
  const amt = parseFloat(amount.replace(',', '.'));
  const go = async (status: 'taken' | 'skipped') => {
    await run(suppTake, { supplementId: t.sup.id, date, time: t.slot, status, amount: amt > 0 ? amt : undefined,
      site: inj && site ? site : undefined, takenAt: new Date(at()).toISOString(), logId: t.log?.id });
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={t.sup.name}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="grid-2">
          <NumberField label="Dose" title={`Dose (${t.sup.unit})`} spec={doseSpec(t.sup.unit)} value={amt > 0 ? amt : null} onChange={(v) => setAmount(String(v))} />
          <label className="field"><span>Taken at</span><input className="input num" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        {inj && (
          <div className="field"><span>Site</span>
            <div className="site-grid">{SITES.map((s) => <button key={s} className={'preset' + (site === s ? ' on' : '')} onClick={() => setSite(s)}>{s}</button>)}</div>
          </div>
        )}
        <button className="btn primary lg block" onClick={() => go('taken')}><Icon name="check" size={20} stroke={2.6} /> Taken</button>
        <div className="row">
          <button className="btn grow" onClick={() => go('skipped')}><Icon name="close" size={16} /> Skipped</button>
          {t.log && <button className="btn danger grow" onClick={async () => { await run(suppUnlog, { logId: t.log!.id }); onClose(); }}><Icon name="trash" size={16} /> Clear</button>}
        </div>
      </div>
    </Sheet>
  );
}

/* ---------------- supplement editor ---------------- */
const KINDS: { value: SchedKind; label: string }[] = [
  { value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Specific days' }, { value: 'interval', label: 'Every few days' },
  { value: 'weekly', label: 'Once a week' }, { value: 'asNeeded', label: 'As needed' },
];
const EVERY: NumberSpec = { min: 2, max: 30, step: 1, decimals: 0, format: (n) => `Every ${n} days`, keyMax: 365 };
const CYCLE: NumberSpec = { min: 1, max: 120, step: 1, decimals: 0, format: (n) => `${n} day${n > 1 ? 's' : ''}`, keyMax: 730 };
const UNIT_OPTS = UNITS.map((u) => ({ value: u, label: u }));
const FORM_OPTS = FORMS.map((f) => ({ value: f.value as SuppForm, label: f.label }));

function SupplementEditor({ open, sup, onClose }: { open: boolean; sup?: Supplement; onClose: () => void }) {
  const today = dateKey();
  const [name, setName] = useState('');
  const [form, setForm] = useState<SuppForm>('capsule');
  const [unit, setUnit] = useState('mg');
  const [doses, setDoses] = useState<DoseStep[]>([]);
  const [amount, setAmount] = useState('');
  const [sched, setSched] = useState<Schedule>({ kind: 'daily', times: ['08:00'], startDate: today });
  const [stock, setStock] = useState('');
  const [notes, setNotes] = useState('');
  const [newDose, setNewDose] = useState<{ amount: string; from: string } | null>(null);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setName(sup?.name ?? ''); setForm(sup?.form ?? 'capsule'); setUnit(sup?.unit ?? 'mg'); setDoses(sup?.doses ?? []);
      setAmount(sup ? '' : ''); setSched(sup?.schedule ?? { kind: 'daily', times: ['08:00'], startDate: today });
      setStock(sup?.stock != null ? String(sup.stock) : ''); setNotes(sup?.notes ?? ''); setNewDose(null);
    }
  }
  const s = sched;
  const setS = (p: Partial<Schedule>) => setSched({ ...s, ...p });
  const currentDose = doses.length ? [...doses].sort((a, b) => a.from.localeCompare(b.from)).reverse().find((d) => d.from <= today)?.amount ?? doses[0].amount : null;
  const valid = name.trim() && (doses.length || parseFloat(amount) > 0) && (s.kind === 'asNeeded' || s.times.some(Boolean)) && (s.kind !== 'weekdays' || (s.days ?? []).length);

  const go = async () => {
    // route, time sorting/clearing and the first dose step are worked out by supplements.save
    const st = parseFloat(stock.replace(',', '.'));
    try {
      await run(suppSave, {
        id: sup?.id, name, form, unit, ...(doses.length ? { doses } : { dose: parseFloat(amount.replace(',', '.')) }),
        schedule: { kind: s.kind, days: s.days, every: s.every, times: s.times.filter(Boolean), startDate: s.startDate, cycle: s.cycle ?? null },
        stock: stock.trim() === '' ? null : Number.isFinite(st) && st >= 0 ? st : undefined, notes,
      });
      onClose();
    } catch (err) { await notice('Could not save', (err as Error).message); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={sup ? 'Edit' : 'New supplement'} full>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" dir="auto" value={name} placeholder="Creatine, Retatrutide, Vitamin D…" onChange={(e) => setName(e.target.value)} /></label>
        <div className="list" style={{ background: 'var(--card-2)' }}>
          <PickerRow label="Form" options={FORM_OPTS} value={form} onChange={setForm} />
          <PickerRow label="Unit" options={UNIT_OPTS} value={unit} onChange={setUnit} />
        </div>

        {doses.length ? (
          <div className="field"><span>Dose history</span>
            <div className="list" style={{ background: 'var(--card-2)' }}>
              {[...doses].sort((a, b) => b.from.localeCompare(a.from)).map((d, i) => (
                <div key={d.from + i} className="list-item">
                  <span className="grow num"><b>{fmtNum(d.amount)} {unit}</b> <span className="muted">from {keyToDate(d.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span></span>
                  {d.amount === currentDose && d.from <= today && <span className="badge good">now</span>}
                  {doses.length > 1 && <button className="icon-btn sm" aria-label="Remove dose step" onClick={() => setDoses(doses.filter((x) => x !== d))}><Icon name="close" size={16} /></button>}
                </div>
              ))}
              {newDose ? (
                <div className="list-item">
                  <NumberField compact label="New dose" spec={doseSpec(unit)} placeholder={unit} style={{ width: 110, flex: 'none' }}
                    value={parseFloat(newDose.amount) > 0 ? parseFloat(newDose.amount) : null} onChange={(v) => setNewDose({ ...newDose, amount: String(v) })} />
                  <input className="input num grow" type="date" value={newDose.from} aria-label="From date" onChange={(e) => setNewDose({ ...newDose, from: e.target.value })} />
                  <button className="icon-btn filled" aria-label="Add dose step" disabled={!(parseFloat(newDose.amount) > 0)}
                    onClick={() => { setDoses([...doses.filter((d) => d.from !== newDose.from), { from: newDose.from, amount: parseFloat(newDose.amount) }]); setNewDose(null); }}><Icon name="check" size={18} /></button>
                </div>
              ) : (
                <button className="list-item pressable" style={{ color: 'var(--accent)' }} onClick={() => setNewDose({ amount: '', from: today })}><Icon name="plus" size={18} /><span className="title">Change dose (titration)</span></button>
              )}
            </div>
          </div>
        ) : (
          <NumberField label={`Dose (${unit})`} spec={doseSpec(unit)} placeholder="Set dose" value={parseFloat(amount) > 0 ? parseFloat(amount) : null} onChange={(v) => setAmount(String(v))} />
        )}

        <div className="list" style={{ background: 'var(--card-2)' }}>
          <PickerRow label="How often" options={KINDS} value={s.kind} onChange={(kind) => setS({ kind, days: kind === 'weekdays' ? s.days ?? [1, 3, 5] : s.days, every: kind === 'interval' ? s.every ?? 2 : s.every })} />
          {s.kind === 'interval' && <NumberRow label="Interval" spec={EVERY} value={s.every ?? 2} onChange={(every) => setS({ every })} />}
        </div>
        {s.kind === 'weekdays' && (
          <div className="week-pick" role="group" aria-label="Days">
            {WEEKDAYS.map((d, i) => {
              const on = (s.days ?? []).includes(i);
              return <button key={i} aria-pressed={on} aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]} className={on ? 'on' : ''}
                onClick={() => setS({ days: on ? (s.days ?? []).filter((x) => x !== i) : [...(s.days ?? []), i] })}>{d}</button>;
            })}
          </div>
        )}
        {s.kind !== 'asNeeded' && (
          <div className="field"><span>Times</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {s.times.map((tm, i) => (
                <span key={i} className="time-chip">
                  <input type="time" className="num" value={tm} aria-label={`Time ${i + 1}`} onChange={(e) => setS({ times: s.times.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {s.times.length > 1 && <button aria-label="Remove time" onClick={() => setS({ times: s.times.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
                </span>
              ))}
              <button className="pill-btn" aria-label="Add time" onClick={() => setS({ times: [...s.times, '20:00'] })}><Icon name="plus" size={16} /></button>
            </div>
          </div>
        )}
        {s.kind !== 'asNeeded' && <>
          <label className="field"><span>{s.kind === 'weekly' ? 'First day (repeats that weekday)' : 'Start date'}</span>
            <input className="input num" type="date" value={s.startDate} onChange={(e) => setS({ startDate: e.target.value || today })} />
          </label>
          <label className="card row" style={{ background: 'var(--card-2)', cursor: 'pointer' }}>
            <span className="grow"><b style={{ fontWeight: 650 }}>On/off cycle</b><br /><span className="muted" style={{ fontSize: '0.8125rem' }}>e.g. 8 weeks on, 4 off</span></span>
            <span className="switch"><input type="checkbox" checked={!!s.cycle} onChange={(e) => setS({ cycle: e.target.checked ? { onDays: 56, offDays: 28 } : null })} /><span /></span>
          </label>
          {s.cycle && (
            <div className="list" style={{ background: 'var(--card-2)' }}>
              <NumberRow label="On for" spec={CYCLE} value={s.cycle.onDays} onChange={(onDays) => setS({ cycle: { ...s.cycle!, onDays } })} />
              <NumberRow label="Off for" spec={CYCLE} value={s.cycle.offDays} onChange={(offDays) => setS({ cycle: { ...s.cycle!, offDays } })} />
            </div>
          )}
        </>}

        <div className="grid-2">
          <label className="field"><span>Stock left (optional)</span><input className="input num" inputMode="decimal" value={stock} placeholder={unit} onChange={(e) => setStock(e.target.value)} /></label>
          <div />
        </div>
        <label className="field"><span>Notes</span><textarea className="input" rows={2} dir="auto" value={notes} placeholder="Brand, with food, reconstitution…" onChange={(e) => setNotes(e.target.value)} /></label>

        <button className="btn primary lg block" onClick={go} disabled={!valid}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {sup && (
          <div className="row">
            <button className="btn grow" onClick={async () => { await run(suppSave, { id: sup.id, archived: !sup.archived }); onClose(); }}>{sup.archived ? 'Resume' : 'Stop taking'}</button>
            <button className="btn danger grow" onClick={async () => {
              if (!(await confirmDialog({ title: `Delete ${sup.name}?`, message: 'Its log history is kept for analysis; it just disappears from the list.', confirm: 'Delete', danger: true }))) return;
              await run(suppDelete, { id: sup.id }); onClose();
            }}><Icon name="trash" size={16} /> Delete</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------------- stack editor ---------------- */
function StackEditor({ open, stack, sups, onClose }: { open: boolean; stack?: Stack; sups: Supplement[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setName(stack?.name ?? ''); setIds(stack?.supplementIds ?? []); } }
  const go = async () => {
    await run(stackSave, { id: stack?.id, name, supplementIds: ids });
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={stack ? 'Edit stack' : 'New stack'}>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field"><span>Name</span><input className="input" dir="auto" value={name} placeholder="Morning stack" onChange={(e) => setName(e.target.value)} /></label>
        <p className="faint" style={{ margin: 0, fontSize: '0.8125rem' }}>Members due at the same time are grouped and checked off together.</p>
        <div className="list" style={{ background: 'var(--card-2)' }}>
          {sups.map((s) => {
            const on = ids.includes(s.id);
            return (
              <button key={s.id} className="list-item pressable" onClick={() => setIds(on ? ids.filter((x) => x !== s.id) : [...ids, s.id])} aria-pressed={on}>
                <span className="grow title" dir="auto">{s.name}</span>
                <span className={'sel-circle' + (on ? ' on' : '')} aria-hidden>{on && <Icon name="check" size={16} stroke={3} />}</span>
              </button>
            );
          })}
        </div>
        <button className="btn primary lg block" onClick={go} disabled={!name.trim() || ids.length < 2}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {stack && <button className="btn danger block" onClick={async () => { await run(stackDelete, { id: stack.id }); onClose(); }}><Icon name="trash" size={16} /> Delete stack</button>}
      </div>
    </Sheet>
  );
}

/* ---------------- notes / side effects ---------------- */
function NoteSheet({ open, sups, onClose }: { open: boolean; sups: Supplement[]; onClose: () => void }) {
  const [text, setText] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setText(''); setTags([]); } }
  const toggle = (t: string) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  return (
    <Sheet open={open} onClose={onClose} title="Note">
      <div className="stack" style={{ gap: 12 }}>
        <textarea className="input" rows={4} dir="auto" autoFocus value={text} placeholder="Nausea after the shot, slept badly, energy great…" onChange={(e) => setText(e.target.value)} />
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          <button className="chip" aria-pressed={tags.includes('side-effect')} onClick={() => toggle('side-effect')}>Side effect</button>
          {sups.filter((s) => !s.archived).map((s) => <button key={s.id} className="chip" aria-pressed={tags.includes(s.id)} onClick={() => toggle(s.id)} dir="auto">{s.name}</button>)}
        </div>
        <button className="btn primary lg block" disabled={!text.trim()} onClick={async () => { await run(notesAdd, { text, tags }); onClose(); }}>
          <Icon name="check" size={20} stroke={2.6} /> Save
        </button>
      </div>
    </Sheet>
  );
}
