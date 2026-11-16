import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog, notice } from '../components/Dialog';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { Link } from 'react-router';
import { Stepper } from '../components/ItemSettings';
import { Icon } from '../components/Icon';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import type { Settings } from '../db/types';
import { fmtDuration } from '../lib/format';
import { readBackupFile, saveBackupFile } from '../lib/backup';
import { run } from '../api/registry';
import { dataExport, dataImport, settingsUpdate } from '../api/body';
import { viewportInfo } from '../lib/viewport';
import { AccountSection } from '../components/Account';

function Toggle({ label, sub, on, onChange, disabled }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="list-item" style={{ opacity: disabled ? 0.5 : 1 }}>
      <span className="grow"><span className="title">{label}</span>{sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
      <span className="switch"><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}
function Line({ label, children }: { label: string; children: ReactNode }) {
  return <div className="list-item"><span className="grow title">{label}</span>{children}</div>;
}

export function SettingsPage() {
  const s = useSettings();
  const f = s.features;
  const set = (patch: z.input<typeof settingsUpdate.input>) => run(settingsUpdate, patch);
  const feat = (k: keyof Settings['features']) => (v: boolean) => set({ features: { [k]: v } });
  const pending = useLiveQuery(() => db.outbox.count(), []) ?? 0;
  return (
    <div className="page">
      <header className="page-head"><h1>Settings</h1></header>

      <div className="section-title">Account</div>
      <AccountSection />

      <div className="section-title">Units</div>
      <div className="list">
        <Line label="Weight">
          <div className="seg" style={{ width: 120 }}>
            {(['kg', 'lb'] as const).map((u) => <button key={u} aria-pressed={s.unit === u} onClick={() => set({ unit: u })}>{u}</button>)}
          </div>
        </Line>
        <Line label="Effort">
          <div className="seg" style={{ width: 120 }}>
            {(['rir', 'rpe'] as const).map((m) => <button key={m} aria-pressed={s.effortMode === m} onClick={() => set({ effortMode: m })}>{m.toUpperCase()}</button>)}
          </div>
        </Line>
      </div>

      <div className="section-title">Features</div>
      <p className="faint" style={{ margin: '-4px 4px 8px', fontSize: '0.8125rem' }}>Anything turned off disappears from the app.</p>
      <div className="list">
        <Toggle label="Gym" on={f.gym} onChange={feat('gym')} />
        <Toggle label="Rest timer" on={f.restTimer} onChange={feat('restTimer')} />
        <Toggle label="RIR / RPE column" on={f.effort} onChange={feat('effort')} />
        <Toggle label="Warm-up sets" on={f.warmups} onChange={feat('warmups')} />
        <Toggle label="Post-workout survey" sub="Effort, sleep, body: 3 taps after a workout" on={f.survey} onChange={feat('survey')} />
        <Toggle label="Food" on={f.food} onChange={feat('food')} />
        <Toggle label="Supplements" on={f.supplements} onChange={feat('supplements')} />
      </div>

      {f.restTimer && <>
        <div className="section-title">Default rest</div>
        <div className="list">
          <Line label="Compound"><Stepper value={s.restCompoundSec} min={15} max={600} step={15} format={(v) => fmtDuration(v * 1000)} onChange={(v) => set({ restCompoundSec: v })} /></Line>
          <Line label="Isolation"><Stepper value={s.restIsolationSec} min={15} max={600} step={15} format={(v) => fmtDuration(v * 1000)} onChange={(v) => set({ restIsolationSec: v })} /></Line>
        </div>
      </>}

      <div className="section-title">Body</div>
      <div className="list">
        <Link to="/weight" className="list-item pressable"><span className="grow title">Weight log</span><Icon name="chevronRight" className="chev" size={18} /></Link>
        <Line label="Weigh-in reminder every"><Stepper value={s.weighInEveryDays} min={1} max={30} format={(v) => `${v} d`} onChange={(v) => set({ weighInEveryDays: v })} /></Line>
      </div>

      <div className="section-title">Data</div>
      <div className="list">
        <button className="list-item pressable" onClick={async () => saveBackupFile(await run(dataExport, {}))}><Icon name="download" size={20} /><span className="grow title">Export backup (JSON)</span></button>
        <label className="list-item pressable" style={{ cursor: 'pointer' }}>
          <Icon name="upload" size={20} /><span className="grow title">Import backup</span>
          <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (!file) return;
            if (!(await confirmDialog({ title: 'Import this backup?', message: 'Records in it replace matching ones here. Nothing else is deleted.', confirm: 'Import' }))) return;
            try { const { imported } = await run(dataImport, await readBackupFile(file)); await notice('Backup imported', `${imported} records restored.`); }
            catch (err) { await notice('Could not import', (err as Error).message); }
          }} />
        </label>
        <ViewportRow />
        <div className="list-item"><span className="grow title">Waiting to sync</span><span className="muted num">{pending ? `${pending} changes` : 'Nothing'}</span></div>
      </div>
      <p className="faint" style={{ fontSize: '0.8125rem', margin: '8px 4px' }}>Everything is saved on this device right away and synced in the background when you're signed in. Export a backup now and then anyway.</p>
    </div>
  );
}

/** Diagnostics for the iOS Home Screen layout (bottom bar position). */
function ViewportRow() {
  const v = viewportInfo();
  return (
    <div className="list-item">
      <span className="grow"><span className="title">Display</span>
        <span className="sub num" style={{ display: 'block' }}>{v.standalone ? 'Home Screen' : 'Browser'} · inner {v.innerHeight} · visual {v.visualHeight} · screen {v.screenHeight} · app {v.appHeight} · doc {v.docHeight}</span></span>
    </div>
  );
}
