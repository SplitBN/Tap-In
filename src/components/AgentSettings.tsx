import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { confirmDialog, notice } from './Dialog';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { run } from '../api/registry';
import { memoryDelete, memoryGet, memoryList, memorySave } from '../api/memory';
import { agentPrefsUpdate } from '../api/agent';
import { useSettings } from '../db/settings';
import { useSync } from '../lib/sync';
import { chatgptDisconnect, chatgptFinish, chatgptStart, getModels, getStatus, isFake, setConfig, setOpenRouterKey } from '../lib/agent/client';
import { invalidateAgentStatus } from '../lib/agent/loop';
import type { AIConfig, AIModel, AIStatus, ProviderId } from '../lib/agent/types';

const NAMES: Record<ProviderId, string> = { chatgpt: 'ChatGPT', openrouter: 'OpenRouter' };

function Toggle({ label, sub, on, onChange }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="list-item">
      <span className="grow"><span className="title">{label}</span>{sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
      <span className="switch"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}

/** Settings → Agent: accounts, models, web, approvals, memory. Credentials go to the server only. */
export function AgentSettings() {
  const s = useSettings();
  const sync = useSync();
  const fake = isFake();
  const [st, setSt] = useState<AIStatus | null>(null);
  const [err, setErr] = useState('');
  const [connect, setConnect] = useState(false);
  const [models, setModels] = useState<Partial<Record<ProviderId, AIModel[]>>>({});
  const canTalk = fake || !!sync.account;

  const refresh = useCallback(async () => {
    if (!canTalk) return;
    try { const r = await getStatus(); setSt(r); setErr(''); invalidateAgentStatus(); } catch (e) { setErr((e as Error).message); }
  }, [canTalk]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!st) return;
    for (const p of ['chatgpt', 'openrouter'] as const) {
      const ok = p === 'chatgpt' ? st.chatgpt.connected : st.openrouter.hasKey;
      if (ok && !models[p]) getModels(p).then((m) => setModels((x) => ({ ...x, [p]: m }))).catch(() => {});
    }
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = async (patch: Partial<AIConfig>) => {
    try { const { config } = await setConfig(patch); setSt((x) => (x ? { ...x, config } : x)); } catch (e) { await notice('Couldn’t save', (e as Error).message); }
  };
  const ask = s.agent?.ask !== false, web = s.agent?.web !== false;

  return (
    <>
      {!canTalk ? (
        <div className="list"><div className="list-item"><Icon name="info" size={18} /><span className="grow sub">Sign in under Account first. The assistant runs through your Tap In server.</span></div></div>
      ) : (
        <>
          {err && <p className="field-err" style={{ margin: '0 4px 8px' }}>{err}</p>}
          <div className="list">
            {st?.chatgpt.connected ? (
              <div className="list-item">
                <span className="role-chip" aria-hidden><Icon name="check" size={16} stroke={2.4} /></span>
                <span className="grow"><span className="title">ChatGPT</span><span className="sub" style={{ display: 'block' }}>{st.chatgpt.email ?? 'Connected'}</span></span>
                <button className="btn ghost" onClick={async () => {
                  if (!(await confirmDialog({ title: 'Disconnect ChatGPT?', message: 'The server forgets the sign-in. You can connect again any time.', confirm: 'Disconnect', danger: true }))) return;
                  try { const r = await chatgptDisconnect(); await refresh(); if (r.revoked === false) await notice('Disconnected here', 'ChatGPT didn’t confirm the sign-out. To be sure, remove Tap In under ChatGPT → Settings → Connected apps.'); } catch (e) { await notice('Couldn’t disconnect', (e as Error).message); }
                }}>Disconnect</button>
              </div>
            ) : (
              <button className="list-item pressable" onClick={() => setConnect(true)}>
                <span className="role-chip" aria-hidden><Icon name="link" size={16} stroke={2} /></span>
                <span className="grow"><span className="title">Connect ChatGPT</span><span className="sub" style={{ display: 'block' }}>Uses your ChatGPT Plus / Pro plan</span></span>
                <Icon name="chevronRight" className="chev" size={18} />
              </button>
            )}
            <OpenRouterRow hasKey={!!st?.openrouter.hasKey} onChange={refresh} />
          </div>

          {st && (
            <>
              <div className="section-title">Provider</div>
              <div className="list">
                <div className="list-item"><span className="grow title">Primary</span>
                  <div className="seg" style={{ width: 210 }}>
                    {(['chatgpt', 'openrouter'] as const).map((p) => <button key={p} aria-pressed={st.config.primary === p} onClick={() => cfg({ primary: p, fallback: st.config.fallback === p ? null : st.config.fallback })}>{NAMES[p]}</button>)}
                  </div>
                </div>
                <div className="list-item"><span className="grow title">Backup</span>
                  <div className="seg" style={{ width: 210 }}>
                    {([null, st.config.primary === 'chatgpt' ? 'openrouter' : 'chatgpt'] as const).map((p) => <button key={p ?? 'none'} aria-pressed={st.config.fallback === p} onClick={() => cfg({ fallback: p })}>{p ? NAMES[p] : 'None'}</button>)}
                  </div>
                </div>
                {(['chatgpt', 'openrouter'] as const).filter((p) => models[p]?.length).flatMap((p) => (['smart', 'cheap'] as const).map((tier) => (
                  <ModelRow key={p + tier} label={`${NAMES[p]} · ${tier === 'smart' ? 'Smart' : 'Fast'}`} models={models[p]!} allowDefault={p === 'chatgpt'}
                    value={st.config.models[p][tier]} onChange={(v) => cfg({ models: { ...st.config.models, [p]: { ...st.config.models[p], [tier]: v } } as AIConfig['models'] })} />
                )))}
              </div>

              <div className="section-title">Web</div>
              <div className="list">
                <Toggle label="Web search" sub={st.openrouter.hasKey ? 'Search and read pages when it helps' : 'Reading pages works; search needs an OpenRouter key'} on={web} onChange={(v) => run(agentPrefsUpdate, { web: v })} />
                {web && st.openrouter.hasKey && models.openrouter?.length && (
                  <ModelRow label="Search model" models={models.openrouter} value={st.config.webModel} onChange={(v) => v && cfg({ webModel: v })} />
                )}
              </div>
            </>
          )}
        </>
      )}

      <div className="section-title">Changes</div>
      <div className="list">
        <Toggle label="Ask before changes" sub="Every change shows a card to Apply or Reject" on={ask} onChange={async (v) => {
          if (!v && !(await confirmDialog({ title: 'Apply changes without asking?', message: 'The assistant will change your data right away. A web page it reads could trick it into changes you didn’t want.', confirm: 'Turn off', danger: true }))) return;
          await run(agentPrefsUpdate, { ask: v });
        }} />
      </div>
      {!ask && <p className="agent-warn">Changes apply without asking. A web page could trick the assistant into changes.</p>}

      <div className="section-title">Memory</div>
      <MemoryList />

      <ConnectSheet open={connect} onClose={() => setConnect(false)} onDone={refresh} />
    </>
  );
}

function ModelRow({ label, models, value, onChange, allowDefault }: { label: string; models: AIModel[]; value: string | null; onChange: (v: string | null) => void; allowDefault?: boolean }) {
  const known = !value || models.some((m) => m.id === value);
  return (
    <label className="list-item">
      <span className="grow title">{label}</span>
      <select className="inline-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {allowDefault && <option value="">Default ({models[0]?.name})</option>}
        {!known && <option value={value!}>{value}</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  );
}

function OpenRouterRow({ hasKey, onChange }: { hasKey: boolean; onChange: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (hasKey) {
    return (
      <div className="list-item">
        <span className="role-chip" aria-hidden><Icon name="check" size={16} stroke={2.4} /></span>
        <span className="grow"><span className="title">OpenRouter</span><span className="sub" style={{ display: 'block' }}>Key saved on the server</span></span>
        <button className="btn ghost" onClick={async () => {
          if (!(await confirmDialog({ title: 'Remove the OpenRouter key?', confirm: 'Remove', danger: true }))) return;
          try { await setOpenRouterKey(null); onChange(); } catch (e) { await notice('Couldn’t remove', (e as Error).message); }
        }}>Remove</button>
      </div>
    );
  }
  return (
    <div className="list-item" style={{ flexWrap: 'wrap' }}>
      <span className="role-chip" aria-hidden><Icon name="bolt" size={16} stroke={2} /></span>
      <span className="grow title">OpenRouter key</span>
      <div className="row" style={{ width: '100%' }}>
        <input className="input grow" type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-…" aria-label="OpenRouter API key" value={key}
          aria-invalid={!!err} onChange={(e) => { setKey(e.target.value); setErr(''); }} />
        <button className="btn primary" disabled={!key.trim() || busy} onClick={async () => {
          setBusy(true);
          try { await setOpenRouterKey(key.trim()); setKey(''); onChange(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? '…' : 'Save'}</button>
      </div>
      {err && <p className="field-err" style={{ width: '100%' }}>{err}</p>}
    </div>
  );
}

/** Paste-the-URL sign-in: the phone can't receive the OAuth redirect, so the user copies the "can't connect" page's address. */
function ConnectSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setUrl(null); setPasted(''); setErr('');
    chatgptStart().then((r) => setUrl(r.url)).catch((e) => setErr((e as Error).message));
  }, [open]);
  const finish = async () => {
    setBusy(true); setErr('');
    try { await chatgptFinish(pasted.trim()); onClose(); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Connect ChatGPT">
      <ol className="agent-steps">
        <li><div>
          <div className="title w-6">Sign in</div>
          <p className="muted t-15" style={{ margin: '2px 0 10px' }}>Opens OpenAI in a new tab.</p>
          <a className={'btn primary' + (url ? '' : ' disabled')} href={url ?? undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!url}
            style={url ? undefined : { opacity: 0.35, pointerEvents: 'none' }}><Icon name="link" size={18} />Open sign-in</a>
        </div></li>
        <li><div>
          <div className="title w-6">Copy the address</div>
          <p className="muted t-15" style={{ margin: '2px 0 0' }}>After signing in you land on a page that <b>can’t connect</b>. That’s expected. Tap its address bar and copy the whole address.</p>
        </div></li>
        <li><div>
          <div className="title w-6">Paste it here</div>
          <textarea className="input" rows={3} style={{ marginTop: 8, width: '100%', resize: 'none' }} placeholder="http://127.0.0.1:1455/auth/callback?code=…" spellCheck={false} autoCapitalize="off"
            aria-label="Address of the can't connect page" value={pasted} aria-invalid={!!err} onChange={(e) => { setPasted(e.target.value); setErr(''); }} />
        </div></li>
      </ol>
      {err && <p className="field-err" style={{ marginTop: 12 }}>{err}</p>}
      <button className="btn lg block primary" style={{ marginTop: 16 }} disabled={!/(code|error)=/.test(pasted) || busy} onClick={finish}>{busy ? 'Connecting…' : 'Connect'}</button>
    </Sheet>
  );
}

function MemoryList() {
  const list = useLiveQuery(() => run(memoryList, {}), []);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="list">
        {list?.length ? list.map((m) => (
          <button key={m.id} className="list-item pressable" onClick={() => setOpen(m.id)}>
            <Icon name="note" size={18} />
            <span className="grow"><span className="title ellipsis" dir="auto" style={{ display: 'block' }}>{m.name}</span>{m.description && <span className="sub ellipsis" dir="auto" style={{ display: 'block' }}>{m.description}</span>}</span>
            <Icon name="chevronRight" className="chev" size={18} />
          </button>
        )) : <div className="list-item"><span className="grow sub">Nothing yet. Tell the assistant “remember …”.</span></div>}
      </div>
      <MemorySheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

function MemorySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const m = useLiveQuery(() => (id ? run(memoryGet, { id }) : undefined), [id]);
  const [f, setF] = useState({ name: '', description: '', content: '' });
  const [err, setErr] = useState('');
  useEffect(() => { if (m) setF({ name: m.name, description: m.description, content: m.content }); setErr(''); }, [m?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!m && (f.name !== m.name || f.description !== m.description || f.content !== m.content);
  return (
    <Sheet open={!!id} onClose={onClose} title="Memory">
      {m && (
        <div className="stack" style={{ gap: 12 }}>
          <label className="field"><span>Name</span><input className="input" dir="auto" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>When it’s useful</span><input className="input" dir="auto" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="field"><span>Note</span><textarea className="input" dir="auto" rows={6} style={{ resize: 'vertical' }} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></label>
          {err && <p className="field-err">{err}</p>}
          <button className="btn lg block primary" disabled={!dirty || !f.name.trim() || !f.content.trim()} onClick={async () => {
            try { await run(memorySave, { id: m.id, ...f }); onClose(); } catch (e) { setErr((e as Error).message); }
          }}>Save</button>
          <button className="btn lg block danger" onClick={async () => {
            if (!(await confirmDialog({ title: 'Delete this memory?', message: 'The assistant forgets it on every device.', confirm: 'Delete', danger: true }))) return;
            await run(memoryDelete, { id: m.id }); onClose();
          }}><Icon name="trash" size={18} />Delete</button>
        </div>
      )}
    </Sheet>
  );
}
