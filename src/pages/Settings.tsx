import { useLiveQuery } from 'dexie-react-hooks';
import { confirmDialog, notice } from '../components/Dialog';
import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { Link } from 'react-router';
import { Stepper } from '../components/ItemSettings';
import { Icon } from '../components/Icon';
import { db } from '../db/db';
import { useSettings } from '../db/settings';
import type { Settings } from '../db/types';
import { fmtDuration, plural } from '../lib/format';
import { readBackupFile, saveBackupFile } from '../lib/backup';
import { run } from '../api/registry';
import { dataExport, dataImport, settingsUpdate } from '../api/body';
import { viewportInfo } from '../lib/viewport';
import { AccountSection } from '../components/Account';
import { AgentSettings } from '../components/AgentSettings';

function Toggle({ label, sub, on, onChange, disabled, icon, role }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean;
  /** module rows get their area's icon + colour */ icon?: string; role?: string }) {
  return (
    <label className="list-item" style={{ opacity: disabled ? 0.5 : 1 }} data-role={role}>
      {icon && <span className="role-chip lg" aria-hidden><Icon name={icon} size={18} stroke={2} /></span>}
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
  const [taps, setTaps] = useState(0); // 5 taps on the footer reveal the display diagnostics
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
        <Toggle label="Gym" icon="dumbbell" role="gym" on={f.gym} onChange={feat('gym')} />
        <Toggle label="Food" icon="food" role="food" on={f.food} onChange={feat('food')} />
        <Toggle label="Supps" icon="pill" role="supp" sub="Supplements, medications and peptides" on={f.supplements} onChange={feat('supplements')} />
        <Toggle label="Agent" icon="sparkle" role="gym" sub="Ask, log and plan by chatting" on={f.agent !== false} onChange={feat('agent')} />
        <Toggle label="Journal" icon="book" role="neutral" sub="Life events: a cut, exam season, being sick" on={f.journal !== false} onChange={feat('journal')} />
      </div>
      {f.gym && <>
        <div className="section-title">Workout</div>
        <div className="list">
          <Toggle label="Rest timer" on={f.restTimer} onChange={feat('restTimer')} />
          <Toggle label="RIR / RPE column" on={f.effort} onChange={feat('effort')} />
          <Toggle label="Warm-up sets" on={f.warmups} onChange={feat('warmups')} />
          <Toggle label="Progression suggestions" sub="Today's target from your rep range. Off: last time's numbers" on={f.progression !== false} onChange={feat('progression')} />
          <Toggle label="Plan week" sub="“Week 3” next to your plan" on={f.planWeek !== false} onChange={feat('planWeek')} />
          <Toggle label="Post-workout survey" sub="Effort, sleep, body: 3 taps after a workout" on={f.survey} onChange={feat('survey')} />
        </div>
      </>}

      {f.food && <>
        <div className="section-title">Food</div>
        <div className="list">
          <Toggle label="Adaptive maintenance" sub="Maintenance from your logs and weight trend. Off: formula only" on={f.adaptiveMaintenance !== false} onChange={feat('adaptiveMaintenance')} />
        </div>
      </>}

      {f.gym && f.restTimer && <>
        <div className="section-title">Default rest</div>
        <div className="list">
          <Line label="Compound"><Stepper label="Compound rest" value={s.restCompoundSec} min={15} max={600} step={15} format={(v) => fmtDuration(v * 1000)} onChange={(v) => set({ restCompoundSec: v })} /></Line>
          <Line label="Isolation"><Stepper label="Isolation rest" value={s.restIsolationSec} min={15} max={600} step={15} format={(v) => fmtDuration(v * 1000)} onChange={(v) => set({ restIsolationSec: v })} /></Line>
        </div>
      </>}

      {f.agent !== false && <>
        <div className="section-title">Agent</div>
        <AgentSettings />
      </>}

      <div className="section-title">Body</div>
      <div className="list">
        <Link to="/weight" className="list-item pressable"><span className="grow title">Weight log</span><Icon name="chevronRight" className="chev" size={18} /></Link>
        <Line label="Weigh-in reminder every"><Stepper label="Weigh-in interval" value={s.weighInEveryDays} min={1} max={30} format={(v) => plural(v, 'day', 'days')} onChange={(v) => set({ weighInEveryDays: v })} /></Line>
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
            let backup;
            try { backup = await readBackupFile(file); }
            catch { await notice('Couldn’t import', 'This file isn’t a Tap In backup. Choose a file exported from Settings → Export backup.'); return; }
            try { const { imported } = await run(dataImport, backup); await notice('Backup imported', `${plural(imported, 'record', 'records')} restored.`); }
            catch (err) {
              const notOurs = /tap in backup|invalid input/i.test((err as Error).message);
              await notice('Couldn’t import', notOurs ? 'This file isn’t a Tap In backup. Choose a file exported from Settings → Export backup.' : 'Couldn’t import the backup. Try again.');
            }
          }} />
        </label>
        {taps >= 5 && <ViewportRow />}
        <div className="list-item"><span className="grow title">Sync</span><span className="muted num">{pending ? `${plural(pending, 'change', 'changes')} waiting` : 'Up to date'}</span></div>
      </div>
      <p className="faint t-13" style={{ margin: '8px 4px' }}>Everything is saved on this device right away and synced in the background when you’re signed in. Export a backup now and then anyway.</p>
      {/* app footer; tapping it 5 times shows the display diagnostics row (debugging the iOS Home Screen layout) */}
      <p className="faint t-13" style={{ textAlign: 'center', margin: '24px 0 0', userSelect: 'none', WebkitUserSelect: 'none' }} onClick={() => setTaps((n) => n + 1)}>Tap In</p>
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
