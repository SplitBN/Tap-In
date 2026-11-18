// Journal: dated life events the logs can't show ("Started cut", "Exam season", "Moved out", "Sick"). Timeline grouped by
// month, ongoing items on top; tap to edit, + to add. Shown on the Calendar and overlaid on the assistant's charts.
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { run } from '../api/registry';
import { journalAdd, journalDelete, journalEnd, journalList, journalUpdate } from '../api/journal';
import type { JournalTag } from '../db/types';
import { keyToDate } from '../lib/nutrition';
import { useToday } from '../lib/today';

type Entry = Awaited<ReturnType<typeof journalList.run>>[number];
export const TAGS: { id: JournalTag; label: string; icon: string }[] = [
  { id: 'diet', label: 'Diet', icon: 'food' }, { id: 'training', label: 'Training', icon: 'dumbbell' }, { id: 'health', label: 'Health', icon: 'pill' },
  { id: 'life', label: 'Life', icon: 'home' }, { id: 'other', label: 'Other', icon: 'flag' },
];
const tagOf = (t?: string) => TAGS.find((x) => x.id === t) ?? TAGS[4];
const fmt = (k: string, year = false) => keyToDate(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
export const journalRange = (j: Entry) => (j.ongoing ? `${fmt(j.date)} – now` : j.endDate && j.endDate !== j.date ? `${fmt(j.date)} – ${fmt(j.endDate)}` : fmt(j.date));
const monthTitle = (k: string) => keyToDate(k).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export function JournalPage() {
  const nav = useNavigate();
  const list = useLiveQuery(() => run(journalList, {}), []);
  const [edit, setEdit] = useState<Entry | 'new' | null>(null);
  const ongoing = (list ?? []).filter((j) => j.ongoing);
  const rest = [...(list ?? [])].filter((j) => !j.ongoing).sort((a, b) => b.date.localeCompare(a.date));
  const months = [...new Set(rest.map((j) => j.date.slice(0, 7)))];
  return (
    <div className="page" data-role="neutral">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/'))}><Icon name="chevronLeft" /></button>
        <h1>Journal</h1>
        <button className="icon-btn filled" aria-label="Add to journal" onClick={() => setEdit('new')}><Icon name="plus" size={22} stroke={2.2} /></button>
      </header>
      <p className="faint t-13" style={{ margin: '-4px 4px 12px' }}>Life events your logs can’t show: a cut, exam season, being sick. They appear on the calendar and in the assistant’s charts.</p>
      {ongoing.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 8 }}>Now</div>
          <div className="list">{ongoing.map((j) => <Row key={j.id} j={j} onOpen={() => setEdit(j)} />)}</div>
        </>
      )}
      {months.map((m) => (
        <div key={m}>
          <div className="section-title">{monthTitle(`${m}-01`)}</div>
          <div className="list">{rest.filter((j) => j.date.startsWith(m)).map((j) => <Row key={j.id} j={j} onOpen={() => setEdit(j)} />)}</div>
        </div>
      ))}
      {list && !list.length && (
        <div className="empty">
          <Icon name="book" size={44} stroke={1.6} />
          <h3>Nothing yet</h3>
          <p>Add “Started cut”, “Exam season” or “Moved out” and see how they line up with your training and food.</p>
          <button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" size={18} stroke={2.4} />Add</button>
        </div>
      )}
      <JournalSheet entry={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function Row({ j, onOpen }: { j: Entry; onOpen: () => void }) {
  const t = tagOf(j.tag);
  return (
    <button className="list-item pressable jrow" onClick={onOpen} data-tag={t.id}>
      <span className="jrow-ic" aria-hidden><Icon name={t.icon} size={16} stroke={2} /></span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="title ellipsis" dir="auto" style={{ display: 'block' }}>{j.title}</span>
        <span className="sub ellipsis" style={{ display: 'block' }}>{journalRange(j)}{j.note ? ` · ${j.note}` : ''}</span>
      </span>
      {j.ongoing && <span className="badge accent">Ongoing</span>}
      <Icon name="chevronRight" className="chev" size={18} />
    </button>
  );
}

type Span = 'day' | 'ongoing' | 'range';
export function JournalSheet({ entry, onClose, date }: { entry: Entry | 'new' | null; onClose: () => void; date?: string }) {
  const today = useToday();
  const isNew = entry === 'new';
  const e = entry && entry !== 'new' ? entry : null;
  const [f, setF] = useState({ title: '', date: today, span: 'day' as Span, endDate: today, tag: 'life' as JournalTag, note: '' });
  const [err, setErr] = useState('');
  const [was, setWas] = useState<typeof entry>(null);
  if (entry !== was) {
    setWas(entry); setErr('');
    if (entry) setF(e ? { title: e.title, date: e.date, span: e.ongoing ? 'ongoing' : e.endDate ? 'range' : 'day', endDate: e.endDate ?? e.date, tag: (e.tag as JournalTag) ?? 'other', note: e.note ?? '' }
      : { title: '', date: date ?? today, span: 'day', endDate: date ?? today, tag: 'life', note: '' });
  }
  const save = async () => {
    try {
      if (e) await run(journalUpdate, { id: e.id, title: f.title, date: f.date, ...(f.span === 'day' ? { singleDay: true } : { endDate: f.span === 'ongoing' ? null : f.endDate }), note: f.note, tag: f.tag });
      else await run(journalAdd, { title: f.title, date: f.date, ...(f.span === 'range' ? { endDate: f.endDate } : {}), ongoing: f.span === 'ongoing', ...(f.note.trim() ? { note: f.note } : {}), tag: f.tag });
      onClose();
    } catch (x) { setErr((x as Error).message); }
  };
  const spans: { id: Span; label: string }[] = [{ id: 'day', label: 'One day' }, { id: 'ongoing', label: 'Ongoing' }, { id: 'range', label: 'From – to' }];
  return (
    <Sheet open={!!entry} onClose={onClose} title={isNew ? 'Add to journal' : 'Journal'}>
      {entry && (
        <form className="stack" style={{ gap: 14 }} onSubmit={(x) => { x.preventDefault(); if (f.title.trim()) void save(); }}>
          <input className="input" dir="auto" placeholder="Started cut, exam season…" aria-label="What happened" value={f.title} maxLength={80} autoFocus={isNew} onChange={(x) => setF({ ...f, title: x.target.value })} />
          <div className="seg" role="radiogroup" aria-label="How long">
            {spans.map((s) => <button key={s.id} type="button" role="radio" aria-checked={f.span === s.id} aria-pressed={f.span === s.id}
              onClick={() => setF({ ...f, span: s.id })}>{s.label}</button>)}
          </div>
          <div className="list">
            <label className="list-item"><span className="grow title">{f.span === 'day' ? 'Date' : 'From'}</span>
              <input className="inline-input num" type="date" value={f.date} max={f.span === 'range' ? f.endDate : undefined} onChange={(x) => x.target.value && setF({ ...f, date: x.target.value })} /></label>
            {f.span === 'range' && <label className="list-item"><span className="grow title">To</span>
              <input className="inline-input num" type="date" value={f.endDate} min={f.date} onChange={(x) => x.target.value && setF({ ...f, endDate: x.target.value })} /></label>}
          </div>
          <div className="chips jtags" role="radiogroup" aria-label="Kind">
            {TAGS.map((t) => <button key={t.id} type="button" className="chip" role="radio" aria-checked={f.tag === t.id} aria-pressed={f.tag === t.id} onClick={() => setF({ ...f, tag: t.id })}><Icon name={t.icon} size={14} stroke={2.2} />{t.label}</button>)}
          </div>
          <textarea className="input" dir="auto" rows={2} placeholder="Note (optional)" aria-label="Note" value={f.note} maxLength={500} onChange={(x) => setF({ ...f, note: x.target.value })} />
          {err && <p className="field-err">{err}</p>}
          <button className="btn lg block primary" disabled={!f.title.trim()}>{isNew ? 'Add' : 'Save'}</button>
          {e?.ongoing && <button type="button" className="btn lg block" onClick={async () => { await run(journalEnd, { id: e.id }); onClose(); }}><Icon name="flag" size={18} />End today</button>}
          {e && <button type="button" className="btn lg block danger" onClick={async () => {
            if (!(await confirmDialog({ title: 'Delete this entry?', confirm: 'Delete', danger: true }))) return;
            await run(journalDelete, { id: e.id }); onClose();
          }}><Icon name="trash" size={18} />Delete</button>}
        </form>
      )}
    </Sheet>
  );
}
