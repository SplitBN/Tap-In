import { useEffect, useState } from 'react';
import { confirmDialog, notice } from './Dialog';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { DEFAULT_API, disablePush, enablePush, pushEnabled, testPush, createInvite, createPairCode, signInWithPairCode, signInWithRecovery, signOut, signUp, syncNow, useSync } from '../lib/sync';

const ago = (ts: number | null) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Settings → Account & sync. */
export function AccountSection() {
  const s = useSync();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<{ title: string; code: string; note: string } | null>(null);
  const statusText = { off: 'Not signed in', idle: 'Synced', syncing: 'Syncing…', offline: 'Offline — will sync later', error: s.error ?? 'Sync error' }[s.status];

  if (!s.account) {
    return (
      <>
        <div className="list">
          <button className="list-item pressable" onClick={() => setOpen(true)}>
            <span className="role-chip" data-role="gym"><Icon name="upload" size={16} stroke={2} /></span>
            <span className="grow"><span className="title">Back up & sync</span><span className="sub" style={{ display: 'block' }}>Keep your data on the server and across devices</span></span>
            <Icon name="chevronRight" className="chev" size={18} />
          </button>
        </div>
        <SignInSheet open={open} onClose={() => setOpen(false)} onRecoveryKey={(key) => setShown({ title: 'Save your recovery key', code: key, note: 'This is the only way back into your account if you lose this phone. Save it in your password manager now — it is not shown again.' })} />
        <CodeSheet shown={shown} onClose={() => setShown(null)} />
      </>
    );
  }
  return (
    <>
      <div className="list">
        <div className="list-item">
          <span className="role-chip" data-role="gym"><Icon name={s.status === 'error' ? 'info' : 'check'} size={16} stroke={2.2} /></span>
          <span className="grow"><span className="title">{s.account.user.name}</span>
            <span className="sub" style={{ display: 'block' }}>{statusText} · {s.pending ? `${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : 'nothing waiting'} · last {ago(s.lastSync)}</span></span>
          <button className="icon-btn filled" aria-label="Sync now" onClick={() => syncNow()} disabled={s.status === 'syncing'}><Icon name="history" size={18} /></button>
        </div>
        <RemindersRow />
        <button className="list-item pressable" onClick={async () => { try { const r = await createPairCode(); setShown({ title: 'Sign in another device', code: r.code, note: 'On the other device: Settings → Back up & sync → Pairing code. Valid for 10 minutes, once.' }); } catch (e) { await notice('Could not create a code', (e as Error).message); } }}>
          <Icon name="link" size={18} /><span className="grow title">Add a device</span><Icon name="chevronRight" className="chev" size={18} />
        </button>
        <button className="list-item pressable" onClick={async () => { try { const r = await createInvite(); setShown({ title: 'Invite a friend', code: r.code, note: 'They open Tap In → Settings → Back up & sync → New account, and enter this code. Works once.' }); } catch (e) { await notice('Could not create an invite', (e as Error).message); } }}>
          <Icon name="plus" size={18} /><span className="grow title">Invite a friend</span><Icon name="chevronRight" className="chev" size={18} />
        </button>
        <button className="list-item pressable" style={{ color: 'var(--danger)' }} onClick={async () => {
          if (!(await confirmDialog({ title: 'Sign out of sync?', message: 'Your data stays on this phone and on the server. Unsynced changes stay queued until you sign in again.', confirm: 'Sign out', danger: true }))) return;
          await signOut();
        }}><Icon name="close" size={18} /><span className="grow title">Sign out</span></button>
      </div>
      <CodeSheet shown={shown} onClose={() => setShown(null)} />
    </>
  );
}

function SignInSheet({ open, onClose, onRecoveryKey }: { open: boolean; onClose: () => void; onRecoveryKey: (k: string) => void }) {
  const [mode, setMode] = useState<'new' | 'recovery' | 'pair'>('new');
  const [api, setApi] = useState(DEFAULT_API);
  const [invite, setInvite] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      if (mode === 'new') { const rk = await signUp(api.trim(), invite, name.trim()); onClose(); onRecoveryKey(rk); }
      else if (mode === 'recovery') { await signInWithRecovery(api.trim(), key.trim()); onClose(); }
      else { await signInWithPairCode(api.trim(), key.trim()); onClose(); }
    } catch (e) { setErr((e as Error).message === 'Failed to fetch' ? 'Could not reach the server. Check the address and your connection.' : (e as Error).message); }
    finally { setBusy(false); }
  };
  const valid = api.trim() && (mode === 'new' ? invite.trim() && name.trim() : key.trim());
  return (
    <Sheet open={open} onClose={onClose} title="Back up & sync">
      <div className="stack" style={{ gap: 12 }}>
        <div className="seg">
          {([['new', 'New account'], ['recovery', 'Recovery key'], ['pair', 'Pairing code']] as const).map(([m, l]) =>
            <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); setErr(''); }} style={{ fontSize: '0.8125rem' }}>{l}</button>)}
        </div>
        {mode === 'new' ? <>
          <label className="field"><span>Invite code</span><input className="input" autoCapitalize="characters" autoCorrect="off" value={invite} onChange={(e) => setInvite(e.target.value)} /></label>
          <label className="field"><span>Your name</span><input className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></label>
        </> : (
          <label className="field"><span>{mode === 'recovery' ? 'Recovery key' : 'Code from your other device'}</span>
            <input className="input num" autoCapitalize={mode === 'pair' ? 'characters' : 'none'} autoCorrect="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} /></label>
        )}
        <details open={!DEFAULT_API}>
          <summary className="faint" style={{ fontSize: '0.8125rem', cursor: 'pointer' }}>Server</summary>
          <input className="input num" style={{ marginTop: 8 }} value={api} onChange={(e) => setApi(e.target.value)} aria-label="Server address" />
        </details>
        {err && <p role="alert" style={{ margin: 0, color: 'var(--danger)', fontSize: '0.875rem' }}>{err}</p>}
        <button className="btn primary lg block" onClick={go} disabled={!valid || busy}><Icon name="check" size={20} stroke={2.6} /> {busy ? 'Connecting…' : mode === 'new' ? 'Create account' : 'Sign in'}</button>
        <p className="faint" style={{ margin: 0, fontSize: '0.75rem' }}>Everything keeps working offline; changes sync in the background. Your existing data is uploaded on first sign-in.</p>
      </div>
    </Sheet>
  );
}

/** Server-sent reminders (supplement doses, weigh-ins). Turning on asks for permission from this tap. */
function RemindersRow() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void pushEnabled().then(setOn); }, []);
  const toggle = async (v: boolean) => {
    setBusy(true);
    try { if (v) await enablePush(); else await disablePush(); setOn(v); }
    catch (e) { await notice('Reminders', (e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="list-item">
      <Icon name="timer" size={18} />
      <span className="grow"><span className="title">Reminders</span><span className="sub" style={{ display: 'block' }}>Supplement doses and weigh-ins</span></span>
      {on && <button className="btn ghost" onClick={async () => { try { const r = await testPush(); await notice(r.sent ? 'Test sent' : 'No device registered', r.sent ? 'It should arrive in a few seconds.' : 'Turn reminders off and on again.'); } catch (e) { await notice('Test failed', (e as Error).message); } }}>Test</button>}
      <span className="switch"><input type="checkbox" aria-label="Reminders" checked={on} disabled={busy} onChange={(e) => toggle(e.target.checked)} /><span /></span>
    </div>
  );
}

/** Show long keys in groups of 5 so they're easy to read and copy by hand (server ignores the dashes). */
const group = (k: string) => (k.length > 12 ? k.match(/.{1,5}/g)!.join('-') : k);

function CodeSheet({ shown, onClose }: { shown: { title: string; code: string; note: string } | null; onClose: () => void }) {
  return (
    <Sheet open={!!shown} onClose={onClose} title={shown?.title}>
      {shown && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="code-box num" aria-label="Code">{group(shown.code)}</div>
          <p className="muted" style={{ margin: 0 }}>{shown.note}</p>
          <button className="btn primary lg block" onClick={async () => { try { await navigator.clipboard.writeText(group(shown.code)); await notice('Copied'); } catch { /* clipboard blocked */ } }}>Copy</button>
        </div>
      )}
    </Sheet>
  );
}
