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
import { chatgptDisconnect, chatgptFinish, chatgptStart, getModels, getStatus, isFake, setConfig, setGlobal, setOpenRouterKey } from '../lib/agent/client';
import { invalidateAgentStatus } from '../lib/agent/loop';
import type { AIConfig, AIGlobal, AIModel, AIStatus, Effort, ProviderId } from '../lib/agent/types';
import type { AgentCategory } from '../db/types';
import { Link } from 'react-router';

const NAMES: Record<ProviderId, string> = { chatgpt: 'ChatGPT', openrouter: 'OpenRouter' };

function Toggle({ label, sub, on, onChange }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="list-item">
      <span className="grow"><span className="title">{label}</span>{sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}</span>
      <span className="switch"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}


const CATS: { id: AgentCategory; label: string; icon: string; role: string }[] = [
  { id: 'food', label: 'Food', icon: 'food', role: 'food' }, { id: 'gym', label: 'Gym', icon: 'dumbbell', role: 'gym' },
  { id: 'supplements', label: 'Supps', icon: 'pill', role: 'supp' }, { id: 'body', label: 'Weight & notes', icon: 'scale', role: 'weight' },
  { id: 'settings', label: 'Settings', icon: 'settings', role: 'neutral' },
];
const EFFORTS: { id: Effort; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }];

/** Settings → Agent. Everyone: accounts, preferred provider, permissions, memory, web. Admin: "For everyone" defaults.
 *  Credentials go to the server only. */
export function AgentSettings() {
  const s = useSettings();
  const sync = useSync();
  const fake = isFake();
  const [st, setSt] = useState<AIStatus | null>(null);
  const [err, setErr] = useState('');
  const [connect, setConnect] = useState(false);
  const [perms, setPerms] = useState(false);
  const canTalk = fake || !!sync.account;

  const refresh = useCallback(async () => {
    if (!canTalk) return;
    try { const r = await getStatus(); setSt(r); setErr(''); invalidateAgentStatus(); } catch (e) { setErr((e as Error).message); }
  }, [canTalk]);
  useEffect(() => { void refresh(); }, [refresh]);

  const cfg = async (patch: Partial<AIConfig>) => {
    try { const { config } = await setConfig(patch); setSt((x) => (x ? { ...x, config } : x)); invalidateAgentStatus(); } catch (e) { await notice('Couldn’t save', (e as Error).message); }
  };
  const web = s.agent?.web !== false;
  const p = s.agent?.permissions ?? {};
  const autoCats = CATS.filter((c) => p[c.id] === 'auto');
  const both = !!st?.chatgpt.connected && !!st?.openrouter.hasKey;

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
            {both && st && (
              <div className="list-item"><span className="grow title">Use first</span>
                <div className="seg" style={{ width: 210 }}>
                  {(['chatgpt', 'openrouter'] as const).map((id) => <button key={id} aria-pressed={st.config.primary === id} onClick={() => cfg({ primary: id, fallback: id === 'chatgpt' ? 'openrouter' : 'chatgpt' })}>{NAMES[id]}</button>)}
                </div>
              </div>
            )}
          </div>
          {both && <p className="faint t-13" style={{ margin: '6px 4px 0' }}>The other one takes over if the first fails. Pick per chat from the model chip.</p>}
        </>
      )}

      <div className="list" style={{ marginTop: 12 }}>
        <button className="list-item pressable" onClick={() => setPerms(true)}>
          <span className="role-chip" aria-hidden><Icon name="check" size={16} stroke={2.2} /></span>
          <span className="grow"><span className="title">Permissions</span><span className="sub" style={{ display: 'block' }}>{autoCats.length ? `Auto: ${autoCats.map((c) => c.label).join(', ')}` : 'Asks before every change'}</span></span>
          <Icon name="chevronRight" className="chev" size={18} />
        </button>
        <Link to="/agent/memory" className="list-item pressable">
          <span className="role-chip" aria-hidden><Icon name="note" size={16} stroke={2} /></span>
          <span className="grow title">Memory</span>
          <Icon name="chevronRight" className="chev" size={18} />
        </Link>
        <Toggle label="Web" sub={!st || st.openrouter.hasKey ? 'Search and read pages when it helps' : 'Reading pages works; search needs an OpenRouter key'} on={web} onChange={(v) => run(agentPrefsUpdate, { web: v })} />
      </div>

      {st?.isAdmin && <AdminSection st={st} onSaved={(global) => { setSt((x) => (x ? { ...x, global } : x)); invalidateAgentStatus(); }} />}

      <PermissionsSheet open={perms} onClose={() => setPerms(false)} />
      <ConnectSheet open={connect} onClose={() => setConnect(false)} onDone={refresh} />
    </>
  );
}

/** One row per category: Ask / Auto. Only the user changes these (agentPrefs.update is never offered to the agent). */
function PermissionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const p = s.agent?.permissions ?? {};
  return (
    <Sheet open={open} onClose={onClose} title="Permissions">
      <p className="muted t-15" style={{ margin: '0 2px 12px' }}>When the assistant wants to change something:</p>
      <div className="list perm-list">
        {CATS.map((c) => (
          <div key={c.id} className="list-item" data-role={c.role}>
            <span className="role-chip" aria-hidden><Icon name={c.icon} size={16} stroke={2} /></span>
            <span className="grow title">{c.label}</span>
            <div className="seg" style={{ width: 132 }} role="radiogroup" aria-label={`${c.label} changes`}>
              {(['ask', 'auto'] as const).map((v) => (
                <button key={v} role="radio" aria-checked={(p[c.id] ?? 'ask') === v} aria-pressed={(p[c.id] ?? 'ask') === v}
                  onClick={() => run(agentPrefsUpdate, { permissions: { [c.id]: v } })}>{v === 'ask' ? 'Ask' : 'Auto'}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="agent-warn">Auto applies changes without a card. A web page the assistant reads could trigger them.</p>
    </Sheet>
  );
}

/** Admin only: defaults for every user (models, routing, effort, web model). */
function AdminSection({ st, onSaved }: { st: AIStatus; onSaved: (g: AIGlobal) => void }) {
  const [models, setModels] = useState<Partial<Record<ProviderId, AIModel[]>>>({});
  const [order, setOrder] = useState((st.global.openrouterProvider?.order ?? []).join(', '));
  useEffect(() => {
    for (const id of ['chatgpt', 'openrouter'] as const) getModels(id).then((m) => setModels((x) => ({ ...x, [id]: m }))).catch(() => {});
  }, []);
  const g = st.global;
  const save = async (patch: Partial<AIGlobal>) => {
    try { const { global } = await setGlobal(patch); onSaved(global); } catch (e) { await notice('Couldn’t save', (e as Error).message); }
  };
  const routing = g.openrouterProvider;
  const saveOrder = () => {
    const list = order.split(',').map((x) => x.trim()).filter(Boolean);
    void save({ openrouterProvider: list.length ? { order: list, allow_fallbacks: routing?.allow_fallbacks ?? true } : null });
  };
  return (
    <>
      <div className="section-title">For everyone <span className="badge accent" style={{ marginLeft: 6 }}>Admin</span></div>
      <div className="list">
        {(['chatgpt', 'openrouter'] as const).map((id) => (
          <ModelRow key={id} label={NAMES[id]} models={models[id] ?? []} value={g.models[id]} onChange={(v) => v && save({ models: { ...g.models, [id]: v } })} />
        ))}
        <div className="list-item" style={{ flexWrap: 'wrap' }}>
          <span className="grow title">OpenRouter routing</span>
          <input className="input" style={{ width: '100%' }} placeholder="Providers in order, e.g. river" aria-label="OpenRouter provider order" value={order}
            onChange={(e) => setOrder(e.target.value)} onBlur={saveOrder} onKeyDown={(e) => e.key === 'Enter' && saveOrder()} />
        </div>
        {routing && <Toggle label="Fall back to other providers" on={routing.allow_fallbacks} onChange={(v) => save({ openrouterProvider: { ...routing, allow_fallbacks: v } })} />}
        <div className="list-item"><span className="grow title">Thinking</span><EffortSeg value={g.defaultEffort} onChange={(v) => save({ defaultEffort: v })} /></div>
        <div className="list-item"><span className="grow"><span className="title">Helpers</span><span className="sub" style={{ display: 'block' }}>Titles, page extracts</span></span><EffortSeg value={g.helperEffort} onChange={(v) => save({ helperEffort: v })} /></div>
        <ModelRow label="Web search model" models={models.openrouter ?? []} value={g.webModel} onChange={(v) => v && save({ webModel: v })} />
      </div>
      <p className="faint t-13" style={{ margin: '6px 4px 0' }}>Applies to every account. OpenRouter lists models without tool support too: pick one that supports tools.</p>
    </>
  );
}
function EffortSeg({ value, onChange }: { value: Effort; onChange: (v: Effort) => void }) {
  return (
    <div className="seg" style={{ width: 200 }} role="radiogroup">
      {EFFORTS.map((e) => <button key={e.id} role="radio" aria-checked={value === e.id} aria-pressed={value === e.id} onClick={() => onChange(e.id)}>{e.label}</button>)}
    </div>
  );
}

function ModelRow({ label, models, value, onChange }: { label: string; models: AIModel[]; value: string | null; onChange: (v: string | null) => void }) {
  const known = !value || models.some((m) => m.id === value);
  return (
    <label className="list-item">
      <span className="grow title">{label}</span>
      <select className="inline-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
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

const SIGNIN_KEY = 'tapin:chatgptSignin';

/** Paste-the-URL sign-in: the phone can't receive the OAuth redirect, so the user copies the "can't connect" page's address. */
function ConnectSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setPasted(''); setErr('');
    // Reuse the sign-in started in the last 8 min: iOS often reloads the app while the OpenAI tab is open, and a fresh
    // start would make the pasted code belong to a different attempt.
    let saved: { url: string; at: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem(SIGNIN_KEY) ?? 'null'); } catch { /* ignore */ }
    if (saved && Date.now() - saved.at < 8 * 60_000) { setUrl(saved.url); return; }
    setUrl(null);
    chatgptStart().then((r) => { setUrl(r.url); try { localStorage.setItem(SIGNIN_KEY, JSON.stringify({ url: r.url, at: Date.now() })); } catch { /* ignore */ } })
      .catch((e) => setErr((e as Error).message));
  }, [open]);
  const finish = async () => {
    setBusy(true); setErr('');
    try { await chatgptFinish(pasted.trim()); try { localStorage.removeItem(SIGNIN_KEY); } catch { /* ignore */ } onClose(); onDone(); }
    catch (e) {
      setErr((e as Error).message);
      if (/start again|try again/i.test((e as Error).message)) try { localStorage.removeItem(SIGNIN_KEY); } catch { /* ignore */ } // next open starts fresh
    } finally { setBusy(false); }
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

export function MemoryList() {
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
