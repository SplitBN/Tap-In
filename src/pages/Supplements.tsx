import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { NumberField, NumberRow, doseSpec, type NumberSpec } from '../components/NumberPicker';
import { PickerRow } from '../components/Picker';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import { alive, db } from '../db/db';
import { FORMS, SITES, UNITS, WEEKDAYS, buildDay, doseOn, nextSite, scheduleText, type DueItem } from '../db/supps';
import type { DoseStep, SchedKind, Schedule, Stack, SuppForm, SuppLog, Supplement } from '../db/types';
import { run } from '../api/registry';
import { notesAdd, notesDelete, recordsRestore, stackDelete, stackSave, suppDelete, suppSave, suppTake, suppUnlog } from '../api/body';
import { fmtNum, plural } from '../lib/format';
import { dateKey, keyToDate, shiftDate } from '../lib/nutrition';
import { Ring } from './Food';
import { useToday } from '../lib/today';

const slotIcon = (slot: string) => {
  if (slot === '--:--') return 'calendar';
  const h = +slot.slice(0, 2);
  return h < 11 ? 'sun' : h < 18 ? 'food' : h < 22 ? 'sunset' : 'moon';
};
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
  const today = useToday();
  const date = params.get('d') ?? today;
  const setDate = (d: string) => setParams(d === today ? {} : { d }, { replace: true });
  const { sups, stacks, logs, day, done, total } = useSuppDay(date);
  const notes = useLiveQuery(() => db.notes.orderBy('at').reverse().filter(alive).limit(5).toArray(), []) ?? [];
  const [taking, setTaking] = useState<{ sup: Supplement; slot: string | null; log?: SuppLog } | null>(null);
  const [editing, setEditing] = useState<Supplement | 'new' | null>(null);
  const [stackEdit, setStackEdit] = useState<Stack | 'new' | null>(null);
  const [noting, setNoting] = useState(false);
  const [menu, setMenu] = useState(false);
  // Home's "Add supplement" lands here with ?new=1
  useEffect(() => { if (params.get('new')) { setEditing('new'); setParams({}, { replace: true }); } }, [params, setParams]);
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
      <div className="gym-top">
        <button className="icon-btn filled" aria-label="Add supplement" onClick={() => setEditing('new')}><Icon name="plus" /></button>
      </div>
      <header className="title-more lt" style={{ marginTop: 0 }}>
        <h1>Supps</h1>
        <button className="more-pill" aria-label="Supplement options" onClick={() => setMenu(true)}><Icon name="more" size={22} stroke={3} /></button>
      </header>

      <div className="date-pill">
        <button className="icon-btn sm" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}><Icon name="chevronLeft" size={18} /></button>
        <button className="date-pill-label" onClick={() => setDate(today)} aria-label={date === today ? 'Today' : `${label}. Go to today`}><Icon name="calendar" size={16} />{label}</button>
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
            <div className="group row supp-progress">
              <Ring value={done} max={total} size={64}><span className="num" style={{ fontWeight: 800 }}>{done}/{total}</span></Ring>
              <div className="grow">
                <div className="w-7 t-20">{done === total ? <>All taken <span aria-hidden>✓</span></> : `${total - done} to go`}</div>
                <div className="muted t-15">✓ logs the dose · tap a row to adjust</div>
              </div>
            </div>
          )}

          {day.map((g) => (
            <section key={g.slot} className="meal" aria-labelledby={`slot-${g.slot}`}>
              <div className="meal-head">
                <span className="role-chip" aria-hidden><Icon name={slotIcon(g.slot)} size={16} stroke={2} /></span>
                <h2 id={`slot-${g.slot}`} className="grow">{slotName(g.slot)}</h2>
                {g.slot !== '--:--' && <span className="num muted">{g.slot}</span>}
              </div>
              <div className="group">
                {g.stacks.map(({ stack, items }) => (
                  <div key={(stack?.id ?? '') + items[0].sup.id} className={stack ? 'stack-box' : undefined}>
                    {stack && (
                      <div className="row stack-head">
                        <Icon name="link" size={16} stroke={2.2} />
                        <span className="grow bidi-start" dir="auto">{stack.name}</span>
                        <button className={'check' + (items.every((i) => i.log?.status === 'taken') ? ' on' : '')} aria-pressed={items.every((i) => i.log?.status === 'taken')}
                          aria-label={items.every((i) => i.log?.status === 'taken') ? `Undo all of ${stack.name}` : `Take all of ${stack.name}`} onClick={() => takeAll(items)}>
                          <Icon name="check" size={18} stroke={2.8} />
                        </button>
                      </div>
                    )}
                    {items.map((d) => (
                      <div key={d.sup.id + d.slot} className="supp-row">
                        <button className="grow supp-main pressable" onClick={() => setTaking({ sup: d.sup, slot: d.slot === '--:--' ? null : d.slot, log: d.log })}>
                          <SuppTile sup={d.sup} />
                          <span className="grow" style={{ minWidth: 0 }}>
                            <span className="fd-name ellipsis supp-name" dir="auto">{d.sup.name}</span>
                            <span className="fd-sub num">
                              {fmtNum(d.log?.amount ?? d.amount)} {d.sup.unit}
                              {d.log?.status === 'taken' && d.log.takenAt ? ` · ${new Date(d.log.takenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}
                              {d.log?.site ? ` · ${d.log.site}` : ''}
                              {d.log?.status === 'skipped' ? ' · skipped' : ''}
                            </span>
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
              </div>
            </section>
          ))}

          {asNeeded.length > 0 && (
            <section className="meal" aria-labelledby="slot-asneeded">
              <div className="meal-head">
                <span className="role-chip" aria-hidden><Icon name="plus" size={16} stroke={2} /></span>
                <h2 id="slot-asneeded" className="grow">As needed</h2>
              </div>
              <div className="group">
                {asNeeded.map((s) => {
                  const n = asNeededLogs.filter((l) => l.supplementId === s.id);
                  return (
                    <div key={s.id} className="supp-row">
                      <button className="grow supp-main pressable" onClick={() => setEditing(s)}>
                        <SuppTile sup={s} />
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span className="fd-name ellipsis supp-name" dir="auto">{s.name}</span>
                          <span className="fd-sub num">{fmtNum(doseOn(s, date))} {s.unit}{n.length ? ` · ${n.length}× today` : ''}</span>
                        </span>
                      </button>
                      <button className="check" aria-label={`Log ${s.name}`} onClick={() => setTaking({ sup: s, slot: null })}><Icon name="plus" size={18} stroke={2.6} /></button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <h2 className="section-title">All</h2>
          <div className="group">
            {sups.map((s) => (
              <button key={s.id} className="fd-row pressable" onClick={() => setEditing(s)} style={s.archived ? { opacity: 0.5 } : undefined}>
                <SuppTile sup={s} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="fd-name ellipsis supp-name" dir="auto">{s.name}</span>
                  <span className="fd-sub">{fmtNum(doseOn(s, today))} {s.unit} · {scheduleText(s.schedule)}{s.stock != null ? ` · ${fmtNum(s.stock)} left` : ''}{s.archived ? ' · stopped' : ''}</span>
                </span>
                <Icon name="chevronRight" className="chev" size={18} />
              </button>
            ))}
          </div>

          {stacks.length > 0 && <>
            <h2 className="section-title">Stacks</h2>
            <div className="group">
              {stacks.map((st) => (
                <button key={st.id} className="fd-row pressable" onClick={() => setStackEdit(st)}>
                  <span className="tile-ic" aria-hidden><Icon name="link" size={20} stroke={2} /></span>
                  <span className="grow" style={{ minWidth: 0 }}><span className="fd-name bidi-start" dir="auto">{st.name}</span>
                    <span className="fd-sub ellipsis">{st.supplementIds.map((id) => sups.find((s) => s.id === id)?.name).filter(Boolean).join(' · ')}</span></span>
                  <Icon name="chevronRight" className="chev" size={18} />
                </button>
              ))}
            </div>
          </>}

          {notes.length > 0 && <>
            <h2 className="section-title">Notes</h2>
            <div className="group">
              {notes.map((n) => (
                <div key={n.id} className="fd-row" style={{ alignItems: 'flex-start' }}>
                  <span className="tile-ic" aria-hidden><Icon name="note" size={20} stroke={2} /></span>
                  <span className="grow" style={{ minWidth: 0 }}><span className="fd-name bidi-start" dir="auto" style={{ fontWeight: 500 }}>{n.text}</span>
                    <span className="fd-sub">{new Date(n.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}{n.tags.includes('side-effect') ? ' · side effect' : ''}</span></span>
                  <button className="icon-btn sm" aria-label="Delete note" onClick={async () => {
                    await run(notesDelete, { id: n.id });
                    toast('Note deleted', () => run(recordsRestore, { table: 'notes', id: n.id }));
                  }}><Icon name="close" size={16} /></button>
                </div>
              ))}
            </div>
          </>}

          <nav className="text-links" aria-label="Supps">
            <button className="text-link" onClick={() => setEditing('new')}>Add supplement</button>
            <button className="text-link" onClick={() => setStackEdit('new')}>New stack</button>
            <button className="text-link" onClick={() => setNoting(true)}>Add note</button>
          </nav>
        </>
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} title="Supps">
        <div className="am">
          <div className="group">
            <button className="am-row pressable" onClick={() => { setMenu(false); setEditing('new'); }}><Icon name="plus" /><span className="grow">Add supplement</span></button>
            <button className="am-row pressable" onClick={() => { setMenu(false); setStackEdit('new'); }}><Icon name="link" /><span className="grow">New stack<span className="am-sub">Taken together, checked off together</span></span></button>
            <button className="am-row pressable" onClick={() => { setMenu(false); setNoting(true); }}><Icon name="note" /><span className="grow">Add note<span className="am-sub">Side effects, sleep, energy</span></span></button>
          </div>
          {date !== today && <nav className="text-links" aria-label="Day"><button className="text-link" onClick={() => { setMenu(false); setDate(today); }}>Go to today</button></nav>}
        </div>
      </Sheet>
      <TakeSheet t={taking} date={date} onClose={() => setTaking(null)} />
      <SupplementEditor open={!!editing} sup={editing === 'new' ? undefined : editing ?? undefined} onClose={() => setEditing(null)} />
      <StackEditor open={!!stackEdit} stack={stackEdit === 'new' ? undefined : stackEdit ?? undefined} sups={sups.filter((s) => !s.archived)} onClose={() => setStackEdit(null)} />
      <NoteSheet open={noting} sups={sups} onClose={() => setNoting(false)} />
    </div>
  );
}

/** Soft tile with the form's icon: syringe for injections, pill for the rest. */
function SuppTile({ sup }: { sup: Supplement }) {
  return <span className="tile-ic" aria-hidden><Icon name={sup.form === 'injection' ? 'syringe' : 'pill'} size={20} stroke={2} /></span>;
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
          <label className="field"><span>Taken at</span><input className="input num date-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        {inj && (
          <div className="field"><span>Site</span>
            <div className="site-grid">{SITES.map((s) => <button key={s} className={'preset' + (site === s ? ' on' : '')} onClick={() => setSite(s)}>{s}</button>)}</div>
          </div>
        )}
        <button className="btn primary lg block" onClick={() => go('taken')}><Icon name="check" size={20} stroke={2.6} /> Taken</button>
        <div className="group">
          <button className="am-row pressable" onClick={() => go('skipped')}><Icon name="close" /><span className="grow">Skipped</span></button>
          {t.log && <button className="am-row pressable danger" onClick={async () => { await run(suppUnlog, { logId: t.log!.id }); onClose(); }}><Icon name="trash" /><span className="grow">Clear</span></button>}
        </div>
      </div>
    </Sheet>
  );
}

/* ---------------- supplement editor ---------------- */
const KINDS: { value: SchedKind; label: string }[] = [
  { value: 'daily', label: 'Daily' }, { value: 'weekdays', label: 'Specific days' }, { value: 'interval', label: 'Every few days' },
  { value: 'weekly', label: 'Once a week' }, { value: 'asNeeded', label: 'As needed' },
];
const EVERY: NumberSpec = { min: 2, max: 30, step: 1, decimals: 0, format: (n) => `Every ${n} days`, keyMax: 365 };
const CYCLE: NumberSpec = { min: 1, max: 120, step: 1, decimals: 0, format: (n) => `${plural(n, 'day', 'days')}`, keyMax: 730 };
const UNIT_OPTS = UNITS.map((u) => ({ value: u, label: u }));
const FORM_OPTS = FORMS.map((f) => ({ value: f.value as SuppForm, label: f.label }));

function SupplementEditor({ open, sup, onClose }: { open: boolean; sup?: Supplement; onClose: () => void }) {
  const today = useToday();
  const [name, setName] = useState('');
  const [form, setForm] = useState<SuppForm>('capsule');
  const [unit, setUnit] = useState('mg');
  const [doses, setDoses] = useState<DoseStep[]>([]);
  const [amount, setAmount] = useState('');
  const [sched, setSched] = useState<Schedule>({ kind: 'daily', times: ['08:00'], startDate: today });
  const [stock, setStock] = useState('');
  const [notes, setNotes] = useState('');
  const [newDose, setNewDose] = useState<{ amount: string; from: string } | null>(null);
  const [err, setErr] = useState<{ field: 'name' | 'dose' | 'days' | 'times' | 'save'; msg: string } | null>(null);
  const ids = { name: useId(), dose: useId(), days: useId(), times: useId(), err: useId() };
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setErr(null);
      setName(sup?.name ?? ''); setForm(sup?.form ?? 'capsule'); setUnit(sup?.unit ?? 'mg'); setDoses(sup?.doses ?? []);
      setAmount(sup ? '' : ''); setSched(sup?.schedule ?? { kind: 'daily', times: ['08:00'], startDate: today });
      setStock(sup?.stock != null ? String(sup.stock) : ''); setNotes(sup?.notes ?? ''); setNewDose(null);
    }
  }
  const s = sched;
  const setS = (p: Partial<Schedule>) => setSched({ ...s, ...p });
  const currentDose = doses.length ? [...doses].sort((a, b) => a.from.localeCompare(b.from)).reverse().find((d) => d.from <= today)?.amount ?? doses[0].amount : null;
  const missing = (): NonNullable<typeof err> | null =>
    !name.trim() ? { field: 'name', msg: 'Give it a name.' }
    : !(doses.length || parseFloat(amount) > 0) ? { field: 'dose', msg: 'Set a dose.' }
    : s.kind === 'weekdays' && !(s.days ?? []).length ? { field: 'days', msg: 'Pick at least one day.' }
    : s.kind !== 'asNeeded' && !s.times.some(Boolean) ? { field: 'times', msg: 'Add a time of day.' } : null;
  const fail = (e: NonNullable<typeof err>) => {
    setErr(e);
    setTimeout(() => { // after the error text renders
      const el = document.getElementById(ids[e.field === 'save' ? 'err' : e.field]);
      (el?.matches('input, button, textarea') ? el : el?.querySelector<HTMLElement>('input, button'))?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };
  const errFor = (f: NonNullable<typeof err>['field']) => (err?.field === f ? { 'aria-invalid': true, 'aria-describedby': ids.err } : {});

  const go = async () => {
    const m = missing();
    if (m) return fail(m);
    // route, time sorting/clearing and the first dose step are worked out by supplements.save
    const st = parseFloat(stock.replace(',', '.'));
    try {
      await run(suppSave, {
        id: sup?.id, name, form, unit, ...(doses.length ? { doses } : { dose: parseFloat(amount.replace(',', '.')) }),
        schedule: { kind: s.kind, days: s.days, every: s.every, times: s.times.filter(Boolean), startDate: s.startDate, cycle: s.cycle ?? null },
        stock: stock.trim() === '' ? null : Number.isFinite(st) && st >= 0 ? st : undefined, notes,
      });
      onClose();
    } catch (e) {
      // the command's messages are written for the agent; say it in plain words here
      const raw = (e as Error).message;
      fail({ field: 'save', msg: /day/i.test(raw) ? 'Pick at least one day.' : /time/i.test(raw) ? 'Add a time of day.' : /name|dose/i.test(raw) ? 'Give it a name and a dose.' : 'Couldn’t save. Try again.' });
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={sup ? sup.name : 'New supplement'} full>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field"><span>Name</span><input id={ids.name} className="input" dir="auto" value={name} placeholder="Creatine, Retatrutide, Vitamin D…" {...errFor('name')} onChange={(e) => { setName(e.target.value); setErr(null); }} /></label>
        <div className="group">
          <PickerRow label="Form" options={FORM_OPTS} value={form} onChange={setForm} />
          <PickerRow label="Unit" options={UNIT_OPTS} value={unit} onChange={setUnit} />
        </div>

        {doses.length ? (
          <div className="field"><span>Dose history</span>
            <div className="group">
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
                <button className="list-item pressable role-text" onClick={() => setNewDose({ amount: '', from: today })}><Icon name="plus" size={18} /><span className="title">Change dose (titration)</span></button>
              )}
            </div>
          </div>
        ) : (
          <div id={ids.dose}><NumberField label={`Dose (${unit})`} spec={doseSpec(unit)} placeholder="Set dose" value={parseFloat(amount) > 0 ? parseFloat(amount) : null} invalid={err?.field === 'dose' ? ids.err : undefined} onChange={(v) => { setAmount(String(v)); setErr(null); }} /></div>
        )}

        <div className="group">
          <PickerRow label="How often" options={KINDS} value={s.kind} onChange={(kind) => setS({ kind, days: kind === 'weekdays' ? s.days ?? [1, 3, 5] : s.days, every: kind === 'interval' ? s.every ?? 2 : s.every })} />
          {s.kind === 'interval' && <NumberRow label="Interval" spec={EVERY} value={s.every ?? 2} onChange={(every) => setS({ every })} />}
        </div>
        {s.kind === 'weekdays' && (
          <div id={ids.days} className="week-pick" role="group" aria-label="Days" aria-describedby={err?.field === 'days' ? ids.err : undefined}>
            {WEEKDAYS.map((d, i) => {
              const on = (s.days ?? []).includes(i);
              return <button key={i} aria-pressed={on} aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]} className={on ? 'on' : ''}
                onClick={() => { setS({ days: on ? (s.days ?? []).filter((x) => x !== i) : [...(s.days ?? []), i] }); setErr(null); }}>{d}</button>;
            })}
          </div>
        )}
        {s.kind !== 'asNeeded' && (
          <div className="field"><span>Times</span>
            <div id={ids.times} className="row" style={{ flexWrap: 'wrap' }} aria-describedby={err?.field === 'times' ? ids.err : undefined}>
              {s.times.map((tm, i) => (
                <span key={i} className="time-chip">
                  <input type="time" className="num" value={tm} aria-label={`Time ${i + 1}`} onChange={(e) => setS({ times: s.times.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {s.times.length > 1 && <button aria-label={`Remove ${tm || 'time'}`} onClick={() => setS({ times: s.times.filter((_, j) => j !== i) })}><Icon name="close" size={16} /></button>}
                </span>
              ))}
              <button className="pill-btn" style={{ minHeight: 44 }} aria-label="Add time" onClick={() => { setS({ times: [...s.times, '20:00'] }); setErr(null); }}><Icon name="plus" size={16} /></button>
            </div>
          </div>
        )}
        {s.kind !== 'asNeeded' && <>
          <div className="group">
            <label className="list-item">
              <span className="grow"><span className="title">{s.kind === 'weekly' ? 'First day' : 'Starts'}</span>{s.kind === 'weekly' && <span className="sub" style={{ display: 'block' }}>Repeats on that weekday</span>}</span>
              <input className="inline-input num" type="date" value={s.startDate} onChange={(e) => setS({ startDate: e.target.value || today })} />
            </label>
          </div>
          <div className="group">
            <label className="am-row" style={{ cursor: 'pointer' }}>
              <Icon name="history" />
              <span className="grow">On/off cycle<span className="am-sub">e.g. 8 weeks on, 4 off</span></span>
              <span className="switch"><input type="checkbox" checked={!!s.cycle} onChange={(e) => setS({ cycle: e.target.checked ? { onDays: 56, offDays: 28 } : null })} /><span /></span>
            </label>
          </div>
          {s.cycle && (
            <div className="group">
              <NumberRow label="On for" spec={CYCLE} value={s.cycle.onDays} onChange={(onDays) => setS({ cycle: { ...s.cycle!, onDays } })} />
              <NumberRow label="Off for" spec={CYCLE} value={s.cycle.offDays} onChange={(offDays) => setS({ cycle: { ...s.cycle!, offDays } })} />
            </div>
          )}
        </>}

        <label className="field"><span>Stock left (optional)</span><input className="input num" inputMode="decimal" value={stock} placeholder={unit} onChange={(e) => setStock(e.target.value)} style={{ maxWidth: 200 }} /></label>
        <label className="field"><span>Notes</span><textarea className="input" rows={2} dir="auto" value={notes} placeholder="Brand, with food, reconstitution…" onChange={(e) => setNotes(e.target.value)} /></label>

        <p id={ids.err} className="field-err" role="status">{err?.msg ?? ''}</p>
        <button className="btn primary lg block" onClick={go}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {sup && (
          <div className="group">
            <button className="am-row pressable" onClick={async () => { await run(suppSave, { id: sup.id, archived: !sup.archived }); onClose(); }}>
              <Icon name={sup.archived ? 'play' : 'close'} /><span className="grow">{sup.archived ? 'Resume' : 'Stop taking'}<span className="am-sub">{sup.archived ? 'Back on the schedule' : 'Hidden from the checklist, history kept'}</span></span>
            </button>
            <button className="am-row pressable danger" onClick={async () => {
              if (!(await confirmDialog({ title: `Delete “${sup.name}”?`, message: 'It disappears from your list and schedule. Its log history is kept. To pause it instead, use Stop taking.', confirm: 'Delete supplement', danger: true }))) return;
              await run(suppDelete, { id: sup.id }); onClose();
            }}><Icon name="trash" /><span className="grow">Delete</span></button>
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
  const [err, setErr] = useState<{ field: 'name' | 'members'; msg: string } | null>(null);
  const nameId = useId(), listId = useId(), errId = useId();
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setName(stack?.name ?? ''); setIds(stack?.supplementIds ?? []); setErr(null); } }
  const go = async () => {
    const e = !name.trim() ? { field: 'name' as const, msg: 'Give the stack a name.' } : ids.length < 2 ? { field: 'members' as const, msg: 'Pick at least 2 supplements.' } : null;
    if (e) { setErr(e); document.getElementById(e.field === 'name' ? nameId : listId)?.querySelector<HTMLElement>('button')?.focus(); if (e.field === 'name') document.getElementById(nameId)?.focus(); return; }
    try { await run(stackSave, { id: stack?.id, name, supplementIds: ids }); onClose(); }
    catch { setErr({ field: 'name', msg: 'Couldn’t save. Try again.' }); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={stack ? 'Edit stack' : 'New stack'}>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field"><span>Name</span><input id={nameId} className="input" dir="auto" value={name} placeholder="Morning stack"
          aria-invalid={err?.field === 'name'} aria-describedby={err?.field === 'name' ? errId : undefined} onChange={(e) => { setName(e.target.value); setErr(null); }} /></label>
        <p className="faint" style={{ margin: 0, fontSize: '0.8125rem' }}>Members due at the same time are grouped and checked off together.</p>
        <div id={listId} className="group" role="group" aria-label="Supplements in this stack" aria-describedby={err?.field === 'members' ? errId : undefined}>
          {sups.map((s) => {
            const on = ids.includes(s.id);
            return (
              <button key={s.id} className="list-item pressable" onClick={() => { setIds(on ? ids.filter((x) => x !== s.id) : [...ids, s.id]); setErr(null); }} aria-pressed={on}>
                <span className="grow title bidi-start" dir="auto">{s.name}</span>
                <span className={'sel-circle' + (on ? ' on' : '')} aria-hidden>{on && <Icon name="check" size={16} stroke={3} />}</span>
              </button>
            );
          })}
        </div>
        <p id={errId} className="field-err" role="status">{err?.msg ?? ''}</p>
        <button className="btn primary lg block" onClick={go}><Icon name="check" size={20} stroke={2.6} /> Save</button>
        {stack && <div className="group"><button className="am-row pressable danger" onClick={async () => {
          await run(stackDelete, { id: stack.id }); onClose();
          toast(`Stack “${stack.name}” deleted`, () => run(recordsRestore, { table: 'stacks', id: stack.id }));
        }}><Icon name="trash" /><span className="grow">Delete stack</span></button></div>}
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
