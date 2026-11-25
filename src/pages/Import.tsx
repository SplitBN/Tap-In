// Settings → Import: bring in Alpha Progression (workouts, plans, custom exercises, bodyweight) and MyNetDiary (food,
// weight) exports. Pick files → each is recognised → preview (counts, ranges, warnings) → exercise matches to check →
// Import with progress → done, with Undo. Everything goes through the import.* commands (src/api/import.ts).
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { confirmDialog, notice } from '../components/Dialog';
import { ExercisePicker } from '../components/ExercisePicker';
import { run } from '../api/registry';
import { importList, importPreview, importRun, importUndo, onImportProgress, type ImportPreview, type ImportProgress } from '../api/import';
import { fmtDate, plural } from '../lib/format';

type FileIn = { name: string; text?: string; base64?: string };
type Override = { kind: 'existing'; id: string } | { kind: 'create' };
type Row = ImportPreview['mapping'][number];

const KIND: Record<string, { icon: string; label: string; role: string }> = {
  'alpha-workouts': { icon: 'history', label: 'Workouts', role: 'gym' },
  'alpha-plans': { icon: 'layers', label: 'Plans', role: 'gym' },
  'alpha-custom': { icon: 'dumbbell', label: 'Custom exercises', role: 'gym' },
  'alpha-measurements': { icon: 'scale', label: 'Bodyweight', role: 'weight' },
  mnd: { icon: 'food', label: 'Food + weight', role: 'food' },
  unknown: { icon: 'info', label: 'Not recognised', role: 'neutral' },
};
const CONF: Record<string, { label: string; cls: string }> = {
  low: { label: 'Loose', cls: 'bad' }, medium: { label: 'Check', cls: 'warn' }, new: { label: 'New', cls: 'new' }, high: { label: 'Exact', cls: 'good' },
};
const CONF_ORDER = ['low', 'medium', 'new', 'high'];

async function readFile(f: File): Promise<FileIn> {
  if (/\.xlsx?$/i.test(f.name) || /excel|spreadsheet/.test(f.type)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: f.name, base64: btoa(s) };
  }
  return { name: f.name, text: (await f.text()).replace(/^﻿/, '') };
}
const fmtRange = (r: { from: string; to: string } | null) => {
  if (!r) return '';
  const y = (d: string) => new Date(d + 'T12:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return y(r.from) === y(r.to) ? y(r.from) : `${y(r.from)} – ${y(r.to)}`;
};

export function ImportPage() {
  const nav = useNavigate();
  const [files, setFiles] = useState<FileIn[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prog, setProg] = useState<ImportProgress | null>(null);
  const [done, setDone] = useState<{ importId: string; written: Record<string, number> } | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const [picking, setPicking] = useState<Row | null>(null);
  const [showAll, setShowAll] = useState(false);
  const past = useLiveQuery(() => run(importList, {}), [done]) ?? [];

  useEffect(() => onImportProgress(setProg), []);
  useEffect(() => {
    if (!files.length) { setPreview(null); return; }
    let live = true;
    setBusy(true); setError(null);
    run(importPreview, { files, overrides }).then((p) => { if (live) setPreview(p); })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [files, overrides]);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setDone(null);
    const read = await Promise.all([...list].map(readFile));
    setFiles((cur) => [...cur.filter((f) => !read.some((r) => r.name === f.name)), ...read]);
  };
  const doImport = async () => {
    if (!preview) return;
    try {
      const r = await run(importRun, { files, overrides });
      setDone({ importId: r.importId, written: r.written });
      setFiles([]); setOverrides({});
    } catch (e) { await notice('Couldn’t import', (e as Error).message); }
  };
  const undo = async (importId: string, label: string) => {
    if (!(await confirmDialog({ title: 'Undo this import?', message: `Removes ${label}. Everything you logged in Tap In stays.`, confirm: 'Undo import', danger: true }))) return;
    await run(importUndo, { importId });
    if (done?.importId === importId) setDone(null);
  };

  const rows = useMemo(() => [...(preview?.mapping ?? [])].sort((a, b) => CONF_ORDER.indexOf(a.confidence) - CONF_ORDER.indexOf(b.confidence) || b.uses - a.uses), [preview]);
  const toCheck = rows.filter((r) => r.confidence !== 'high' && !r.overridden);
  const shown = showAll ? rows : rows.filter((r) => r.confidence !== 'high' || r.overridden);
  const c = preview?.counts;
  const nothingNew = !!c && !c.sessions.new && !c.sets.new && !c.plans.new && !c.weighIns.new && !c.foodEntries.new;

  return (
    <div className="page imp" data-role="gym">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/settings'))}><Icon name="chevronLeft" /></button>
        <h1 className="small">Import</h1>
        <label className="icon-btn filled" aria-label="Add files" style={{ cursor: 'pointer' }}>
          <Icon name="plus" />
          <input type="file" multiple accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel" className="sr-only" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        </label>
      </header>

      {done && (
        <section className="card imp-done" aria-live="polite">
          <span className="imp-done-ic" aria-hidden><Icon name="check" size={22} stroke={3} /></span>
          <div className="grow">
            <b className="t-17">Imported</b>
            <p className="muted t-15" style={{ margin: '2px 0 0' }}>{doneText(done.written)}</p>
          </div>
          <button className="btn danger" onClick={() => undo(done.importId, doneText(done.written))}>Undo</button>
        </section>
      )}

      {!files.length && !done && (
        <label className="empty imp-pick pressable">
          <Icon name="upload" size={40} />
          <h3>Alpha Progression · MyNetDiary</h3>
          <p>Workouts, plans, custom exercises and bodyweight (.csv), food and weight (.xls). Pick all the files at once.</p>
          <span className="btn primary"><Icon name="plus" size={18} />Choose files</span>
          <input type="file" multiple accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel" className="sr-only" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        </label>
      )}

      {files.length > 0 && <>
        <h2 className="section-title">{plural(files.length, 'file', 'files')}</h2>
        <div className="group">
          {files.map((f) => {
            const info = preview?.files.find((x) => x.name === f.name);
            const k = KIND[info?.kind ?? ''] ?? null;
            return (
              <div key={f.name} className="fd-row" data-role={k?.role}>
                <span className="role-chip lg" aria-hidden><Icon name={k?.icon ?? 'upload'} size={18} stroke={2} /></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="fd-name ellipsis">{f.name}</span>
                  <span className="fd-sub">{k ? <>{k.label}{info!.rows ? <> · <span className="num">{info!.rows.toLocaleString()}</span></> : null}</> : 'Reading…'}</span>
                </span>
                <button className="icon-btn sm" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.name !== f.name))}><Icon name="close" size={16} /></button>
              </div>
            );
          })}
        </div>
      </>}

      {error && <p className="imp-warn" role="alert"><Icon name="info" size={16} />{error}</p>}

      {preview && c && <>
        <h2 className="section-title">Preview{busy ? '…' : ''}</h2>
        <div className="imp-tiles">
          <Tile icon="history" role="gym" value={c.sessions.new} label="Workouts" sub={fmtRange(preview.ranges.workouts)} skip={c.sessions.existing} />
          <Tile icon="check" role="gym" value={c.sets.new} label="Sets" skip={c.sets.existing} />
          <Tile icon="layers" role="gym" value={c.plans.new} label="Plans" skip={c.plans.existing} />
          <Tile icon="dumbbell" role="gym" value={c.exercises.toCreate} label="New exercises" sub={`${c.exercises.mapped} matched`} />
          <Tile icon="scale" role="weight" value={c.weighIns.new} label="Weigh-ins" sub={[fmtRange(preview.ranges.weighIns), c.weighIns.duplicate ? `${c.weighIns.duplicate} already here` : ''].filter(Boolean).join(' · ')} skip={c.weighIns.existing} />
          <Tile icon="food" role="food" value={c.foodEntries.new} label="Food entries" sub={[c.foodDays ? plural(c.foodDays, 'day', 'days') : '', fmtRange(preview.ranges.food)].filter(Boolean).join(' · ')} skip={c.foodEntries.existing} />
        </div>
        {preview.warnings.length > 0 && (
          <div className="group imp-warns">
            {preview.warnings.map((w) => <p key={w} className="imp-warn"><Icon name="info" size={16} />{w}</p>)}
          </div>
        )}

        {rows.length > 0 && <>
          <div className="imp-ex-head">
            <h2 className="section-title" style={{ margin: 0 }}>Exercises</h2>
            <div className="seg" role="tablist" style={{ width: 168 }}>
              <button role="tab" aria-selected={!showAll} onClick={() => setShowAll(false)}>Check <span className="num">{rows.length - rows.filter((r) => r.confidence === 'high' && !r.overridden).length}</span></button>
              <button role="tab" aria-selected={showAll} onClick={() => setShowAll(true)}>All <span className="num">{rows.length}</span></button>
            </div>
          </div>
          <p className="imp-legend faint t-13" aria-hidden>
            {CONF_ORDER.map((k) => <span key={k}><i className={'imp-dot ' + CONF[k].cls} />{CONF[k].label}</span>)}
          </p>
          <div className="group">
            {shown.map((r) => (
              <button key={r.key} className="fd-row pressable imp-row" onClick={() => setEdit(r)} aria-haspopup="dialog"
                aria-label={`${r.name}, ${r.equipment}: ${r.create ? 'new exercise' : r.targetName}. ${r.overridden ? 'Your choice' : CONF[r.confidence].label}. Change`}>
                <i className={'imp-dot ' + (r.overridden ? 'good' : CONF[r.confidence].cls)} aria-hidden />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="fd-name ellipsis">{r.name} <span className="eq">{r.equipment}</span></span>
                  <span className="fd-sub ellipsis">
                    <Icon name="chevronRight" size={13} stroke={2.6} />{r.create && <span className="badge accent imp-new">New</span>}{r.targetName}
                  </span>
                </span>
                <span className="faint num t-13" title="Workouts">{r.uses || ''}</span>
              </button>
            ))}
            {!shown.length && <p className="muted t-15" style={{ padding: '12px 16px', margin: 0 }}><Icon name="check" size={14} stroke={3} /> Every exercise matched exactly.</p>}
          </div>
        </>}

        <div className="imp-go">
          {prog ? (
            <div className="imp-prog" role="progressbar" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done} aria-label="Importing">
              <span style={{ width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 4}%` }} />
              <b className="num">{prog.total ? `${Math.round((prog.done / prog.total) * 100)}%` : '…'}</b>
            </div>
          ) : (
            <button className="btn primary lg block" disabled={busy || nothingNew} onClick={doImport}>
              <Icon name="download" size={20} />{nothingNew ? 'Already imported' : toCheck.length ? `Import · ${toCheck.length} to check` : 'Import'}
            </button>
          )}
        </div>
      </>}

      {past.length > 0 && <>
        <h2 className="section-title">Past imports</h2>
        <div className="group">
          {past.map((p) => {
            const label = pastText(p.counts);
            return (
              <div key={p.importId} className="fd-row">
                <span className="tile-ic date-tile" aria-hidden><b className="num">{new Date(p.at).getDate()}</b><small>{new Date(p.at).toLocaleDateString(undefined, { month: 'short' })}</small></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="fd-name">{fmtDate(Date.parse(p.at))}</span>
                  <span className="fd-sub">{p.undone ? 'Undone' : label}</span>
                </span>
                {!p.undone && <button className="btn danger" onClick={() => undo(p.importId, label)}>Undo</button>}
              </div>
            );
          })}
        </div>
      </>}

      <ExerciseSheet row={edit} onClose={() => setEdit(null)}
        onPick={() => { setPicking(edit); setEdit(null); }}
        onCreate={() => { setOverrides((o) => ({ ...o, [edit!.key]: { kind: 'create' } })); setEdit(null); }}
        onReset={() => { setOverrides((o) => { const n = { ...o }; delete n[edit!.key]; return n; }); setEdit(null); }} />
      <ExercisePicker open={!!picking} title={picking ? `Match “${picking.name}”` : 'Match exercise'} onClose={() => setPicking(null)}
        onPick={(exs) => { if (picking && exs[0]) setOverrides((o) => ({ ...o, [picking.key]: { kind: 'existing', id: exs[0].id } })); setPicking(null); }} />
    </div>
  );
}

function Tile({ icon, role, value, label, sub, skip }: { icon: string; role: string; value: number; label: string; sub?: string; skip?: number }) {
  return (
    <div className="imp-tile" data-role={role}>
      <span className="row" style={{ gap: 6 }}><Icon name={icon} size={15} stroke={2.2} /><span className="imp-tile-label">{label}</span></span>
      <b className="num imp-tile-value">{value.toLocaleString()}</b>
      {(sub || skip) ? <span className="imp-tile-sub">{[sub, skip ? `${skip.toLocaleString()} already in` : ''].filter(Boolean).join(' · ')}</span> : null}
    </div>
  );
}

function ExerciseSheet({ row, onClose, onPick, onCreate, onReset }: { row: Row | null; onClose: () => void; onPick: () => void; onCreate: () => void; onReset: () => void }) {
  return (
    <Sheet open={!!row} onClose={onClose} title={row?.name}>
      {row && (
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted t-15" style={{ margin: 0 }}>
            <span className="eq">{row.equipment}</span> · {plural(row.uses, 'workout', 'workouts')}<br />
            <Icon name="chevronRight" size={13} stroke={2.6} /> <b style={{ color: 'var(--text)' }}>{row.targetName}</b>{row.create ? ' (new)' : ''} · {row.why}
          </p>
          {row.note && <p className="faint t-13" style={{ margin: 0 }}><Icon name="note" size={13} /> {row.note}</p>}
          <button className="btn lg block" onClick={onPick}><Icon name="search" size={18} />Pick exercise</button>
          <button className="btn lg block" onClick={onCreate}><Icon name="plus" size={18} />New custom exercise</button>
          {row.overridden && <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={onReset}>Back to suggestion</button>}
        </div>
      )}
    </Sheet>
  );
}

const LABELS: [string, string, string][] = [['sessions', 'workout', 'workouts'], ['plans', 'plan', 'plans'], ['bodyweight', 'weigh-in', 'weigh-ins'], ['entries', 'food entry', 'food entries'], ['exercises', 'exercise', 'exercises']];
const doneText = (w: Record<string, number>) => LABELS.filter(([k]) => w[k]).map(([k, s, p]) => plural(w[k], s, p)).join(', ') || 'Nothing new';
const pastText = (c: Record<string, number>) => LABELS.filter(([k]) => c[k]).map(([k, s, p]) => plural(c[k], s, p)).join(', ') || 'Nothing left';
