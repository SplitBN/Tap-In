import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { confirmDialog, notice } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { useSync } from '../lib/sync';
import { isFake } from '../lib/agent/client';
import { deleteChat, getChat, keepChat, newChat, renameChat, setChatContext, useChat, useChats } from '../lib/agent/chats';
import { describeAction, type Described } from '../lib/agent/describe';
import { downscaleImage } from '../lib/agent/image';
import { isContextPart } from '../lib/agent/instructions';
import { needsReply, recoverChat, resolvePending, runLoop, sendMessage, stop, useLive } from '../lib/agent/loop';
import { setQuickChat, useQuickChat } from '../lib/agent/quick';
import { chipLabel } from '../lib/agent/tools';
import type { AIMessage, AIPart, AIToolCall, AgentContext, Chat, PendingRequest, RequestAction } from '../lib/agent/types';
import { dateKey } from '../lib/nutrition';

const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const lastText = (c: Chat) => {
  for (let i = c.messages.length - 1; i >= 0; i--) { const m = c.messages[i]; if (m.role === 'assistant' && m.text) return m.text; }
  return '';
};

/** /agent — chat history. Quick chats (photo logging etc.) sit behind the Quick filter and expire after 3 days. */
export function AgentPage() {
  const nav = useNavigate();
  const all = (useChats() ?? []).filter((c) => c.messages.length);
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'quick' ? 'quick' : 'chats';
  const chats = all.filter((c) => (c.kind === 'quick') === (view === 'quick'));
  const quickCount = all.filter((c) => c.kind === 'quick').length;
  const [menu, setMenu] = useState<Chat | null>(null);
  const sync = useSync();
  const ready = isFake() || !!sync.account;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Agent</h1>
        <button className="icon-btn filled" aria-label="New chat" onClick={() => nav('/agent/new')}><Icon name="plus" size={22} stroke={2.2} /></button>
      </header>
      {!ready && (
        <Link to="/settings" className="list-item pressable card agent-setup">
          <span className="role-chip lg" aria-hidden><Icon name="info" size={18} stroke={2} /></span>
          <span className="grow"><span className="title">Set up first</span><span className="sub" style={{ display: 'block' }}>Sign in (Back up & sync), then connect ChatGPT or OpenRouter in Settings → Agent</span></span>
          <Icon name="chevronRight" className="chev" size={18} />
        </Link>
      )}
      {(quickCount > 0 || view === 'quick') && (
        <div className="seg chat-filter" role="tablist" aria-label="Show">
          <button role="tab" aria-selected={view === 'chats'} onClick={() => setParams({}, { replace: true })}>Chats</button>
          <button role="tab" aria-selected={view === 'quick'} onClick={() => setParams({ view: 'quick' }, { replace: true })}>Quick{quickCount ? ` · ${quickCount}` : ''}</button>
        </div>
      )}
      {view === 'quick' && <p className="faint t-13" style={{ margin: '0 4px 8px' }}>Photo logs and other quick chats. Deleted after 3 days unless you keep them.</p>}
      {chats.length ? (
        <div className="list">
          {chats.map((c) => (
            <div key={c.id} className="list-item chat-row">
              <Link to={`/agent/${c.id}`} className="grow plain chat-row-main">
                <span className="row" style={{ gap: 6 }}>
                  <span className="title ellipsis grow" dir="auto">{c.title}</span>
                  {c.pending?.status === 'pending' && <span className="badge accent">Waiting</span>}
                  <span className="faint t-13 num">{ago(c.updatedAt)}</span>
                </span>
                <span className="sub ellipsis" dir="auto" style={{ display: 'block' }}>{lastText(c) || ' '}</span>
              </Link>
              <button className="icon-btn sm" aria-label={`Options for ${c.title}`} onClick={() => setMenu(c)}><Icon name="more" size={20} stroke={2.6} /></button>
            </div>
          ))}
        </div>
      ) : view === 'quick' ? (
        <div className="empty compact"><p>No quick chats.</p></div>
      ) : (
        <div className="empty">
          <Icon name="sparkle" size={44} stroke={1.6} />
          <h3>Ask Tap In</h3>
          <p>Log food by talking, check your progress, plan a workout. Changes always ask first.</p>
          <button className="btn primary" onClick={() => nav('/agent/new')}><Icon name="plus" size={18} stroke={2.4} />New chat</button>
        </div>
      )}
      <ChatMenu chat={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** Rename / Keep / Delete for one chat (in-app sheet, no browser dialogs). */
function ChatMenu({ chat, onClose }: { chat: Chat | null; onClose: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [was, setWas] = useState<Chat | null>(null);
  if (chat !== was) { setWas(chat); setRenaming(false); setTitle(chat?.title ?? ''); }
  const save = async () => { if (chat && title.trim()) { await renameChat(chat.id, title); onClose(); } };
  return (
    <Sheet open={!!chat} onClose={onClose} title={renaming ? 'Rename' : chat?.title}>
      {chat && (renaming ? (
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input className="input" dir="auto" aria-label="Chat name" value={title} autoFocus maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn lg block primary" disabled={!title.trim()}>Save</button>
        </form>
      ) : (
        <div className="menu-group" style={{ marginTop: 0 }}>
          <button className="menu-item" onClick={() => setRenaming(true)}><Icon name="pencil" size={22} />Rename</button>
          {chat.kind === 'quick' && <button className="menu-item" onClick={async () => { await keepChat(chat.id); onClose(); }}><Icon name="check" size={22} />Keep</button>}
          <button className="menu-item danger" onClick={async () => {
            onClose();
            if (await confirmDialog({ title: 'Delete this chat?', message: 'Memories it saved stay.', confirm: 'Delete', danger: true })) await deleteChat(chat.id);
          }}><Icon name="trash" size={22} />Delete</button>
        </div>
      ))}
    </Sheet>
  );
}

/** /agent/new?from=…&d=… — reuse the newest empty chat or start one, with the screen it was opened from. */
export function AgentNewPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const chats = useChats();
  const started = useRef(false);
  useEffect(() => {
    if (!chats || started.current) return;
    started.current = true;
    const ctx: AgentContext = { route: params.get('from') ?? '/agent', ...(params.get('d') ? { date: params.get('d')! } : {}) };
    (async () => {
      const empty = chats.find((c) => !c.messages.length && c.kind !== 'quick');
      if (empty) await setChatContext(empty.id, ctx);
      const id = empty?.id ?? (await newChat(ctx)).id;
      nav(`/agent/${id}`, { replace: true });
    })();
  }, [chats, params, nav]);
  return <div className="page" />;
}

/** /agent/:id — one chat, full screen. */
export function AgentChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const chat = useChat(id);
  const [menu, setMenu] = useState<Chat | null>(null);
  if (chat === undefined && id) return <div className="page" />;
  if (!chat) return <div className="page"><header className="page-head"><h1>Agent</h1></header><p className="muted">This chat no longer exists.</p></div>;
  return (
    <div className="page no-tabs chat-page">
      <header className="page-head chat-head">
        <button className="icon-btn" aria-label="All chats" onClick={() => nav(chat.kind === 'quick' ? '/agent?view=quick' : '/agent')}><Icon name="chevronLeft" size={24} /></button>
        <h1 className="small ellipsis" dir="auto">{chat.messages.length ? chat.title : 'New chat'}</h1>
        {chat.messages.length > 0 && <button className="icon-btn" aria-label="Chat options" onClick={() => setMenu(chat)}><Icon name="more" size={22} stroke={2.6} /></button>}
        <button className="icon-btn" aria-label="New chat" onClick={() => nav(`/agent/new?from=${encodeURIComponent(chat.context?.route ?? '/agent')}`)}><Icon name="plus" size={22} /></button>
      </header>
      <ChatBody chat={chat} />
      <ChatMenu chat={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** Messages + composer; used by the full-screen chat and the quick-chat sheet. */
function ChatBody({ chat }: { chat: Chat }) {
  const live = useLive(chat.id);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void recoverChat(chat.id); }, [chat.id]);
  // follow the conversation while the user is near the bottom (the scroller is the page, or the sheet body)
  const count = chat.messages.length;
  useLayoutEffect(() => {
    const end = endRef.current;
    const box = end?.closest('.sheet-body') ?? document.querySelector('.app');
    if (!end || !box) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 240 || live.text === '') end.scrollIntoView({ block: 'end' });
  }, [count, live.text, live.running, chat.pending?.toolCallId, chat.error]);

  const results = new Map<string, string>();
  for (const m of chat.messages) if (m.role === 'tool') results.set(m.toolCallId, m.content);
  const showRetry = !live.running && (!!chat.error || needsReply(chat));
  return (
    <>
      <div className="msgs" aria-live="polite" aria-busy={live.running}>
        {!chat.messages.length && <EmptyChat onPick={(t) => sendMessage(chat.id, [{ type: 'text', text: t }])} />}
        {chat.messages.map((m, i) => <Message key={i} m={m} chat={chat} results={results} />)}
        {live.running && (live.text
          ? <div className="bubble bot streaming" dir="auto"><Rich text={live.text} /><span className="caret" aria-hidden /></div>
          : <div className="typing" aria-label="Thinking"><i /><i /><i /></div>)}
        {chat.error && !live.running && <div className="chat-error" role="alert"><Icon name="info" size={16} stroke={2.2} /><span className="grow">{chat.error}</span></div>}
        {showRetry && <button className="btn chat-retry" onClick={() => runLoop(chat.id)}><Icon name="history" size={16} />Retry</button>}
        <div ref={endRef} />
      </div>
      <Composer chat={chat} running={live.running} />
    </>
  );
}

/** Quick chats (lib/agent/quick.ts) open here, as a sheet over the current page. */
export function QuickChatHost() {
  const id = useQuickChat();
  const chat = useChat(id ?? undefined);
  const nav = useNavigate();
  const close = () => setQuickChat(null);
  return (
    <Sheet open={!!id} onClose={close} full title={<span className="ellipsis" dir="auto" style={{ display: 'block' }}>{chat?.title ?? 'Assistant'}</span>}
      actions={chat && (
        <>
          {chat.kind === 'quick'
            ? <button className="pill-btn" onClick={() => keepChat(chat.id)} aria-label="Keep this chat"><Icon name="check" size={16} stroke={2.6} />Keep</button>
            : <span className="faint t-13 w-6 quick-kept"><Icon name="check" size={14} stroke={2.6} />Kept</span>}
          <button className="icon-btn" aria-label="Open full screen" onClick={() => { close(); nav(`/agent/${chat.id}`); }}><Icon name="chevronUp" size={22} /></button>
        </>
      )}>
      {chat && <div className="quick-chat"><ChatBody chat={chat} /></div>}
    </Sheet>
  );
}


function EmptyChat({ onPick }: { onPick: (t: string) => void }) {
  const ideas = ['How was my training this week?', 'What did I eat today?', 'Log 2 eggs for breakfast'];
  return (
    <div className="chat-empty">
      <span className="chat-empty-glyph" aria-hidden><Icon name="sparkle" size={30} stroke={1.7} /></span>
      <div className="stack" style={{ gap: 8, width: '100%' }}>
        {ideas.map((t) => <button key={t} className="mini-row pressable" onClick={() => onPick(t)}><span className="grow">{t}</span><Icon name="arrowUp" size={16} /></button>)}
      </div>
    </div>
  );
}

/** Minimal formatting: paragraphs, line breaks, **bold**. */
function Rich({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((s, i) => (s.startsWith('**') && s.endsWith('**') && s.length > 4 ? <b key={i}>{s.slice(2, -2)}</b> : <Fragment key={i}>{s}</Fragment>))}</>;
}

function Message({ m, chat, results }: { m: AIMessage; chat: Chat; results: Map<string, string> }) {
  if (m.role === 'tool') return null;
  if (m.role === 'user') {
    return (
      <div className="bubble user" dir="auto">
        {m.content.map((p, i) => (p.type === 'image'
          ? <img key={i} className="bubble-img" alt="Attached photo" src={`data:${p.mime};base64,${p.base64}`} />
          : isContextPart(p.text) ? null : <Fragment key={i}>{p.text}</Fragment>))}
      </div>
    );
  }
  const calls = m.toolCalls ?? [];
  return (
    <>
      {m.text && <div className="bubble bot" dir="auto"><Rich text={m.text} /></div>}
      {calls.length > 0 && (
        <div className="tool-chips">
          {calls.filter((c) => c.name !== 'request_changes').map((c) => <ToolChip key={c.id} call={c} failed={isError(results.get(c.id))} />)}
        </div>
      )}
      {calls.filter((c) => c.name === 'request_changes').map((c) => <RequestBlock key={c.id} call={c} chat={chat} result={results.get(c.id)} />)}
    </>
  );
}
const isError = (content?: string) => { if (!content) return false; try { return 'error' in (JSON.parse(content) as object); } catch { return false; } };

function ToolChip({ call, failed }: { call: AIToolCall; failed?: boolean }) {
  const { icon, text } = chipLabel(call);
  return <span className={'tool-chip' + (failed ? ' failed' : '')}><Icon name={failed ? 'info' : icon} size={13} stroke={2.2} />{text}{failed ? ' · failed' : ''}</span>;
}

function RequestBlock({ call, chat, result }: { call: AIToolCall; chat: Chat; result?: string }) {
  if (chat.pending?.toolCallId === call.id) return <RequestCard chatId={chat.id} p={chat.pending} />;
  const done = chat.cards?.[call.id];
  if (done) return <RequestCard chatId={chat.id} p={{ toolCallId: call.id, summary: done.summary, actions: done.actions, status: 'pending' }} outcome={done.outcome} comment={done.comment} />;
  if (result && isError(result)) return <div className="tool-chips"><span className="tool-chip failed"><Icon name="info" size={13} stroke={2.2} />Request didn’t validate · retrying</span></div>;
  return null;
}

function useDescribed(actions: RequestAction[]) {
  const [d, setD] = useState<Described[] | null>(null);
  const key = JSON.stringify(actions);
  useEffect(() => { let alive = true; Promise.all(actions.map(describeAction)).then((x) => alive && setD(x)); return () => { alive = false; }; }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return d;
}

const OUTCOME: Record<string, { icon: string; text: string; cls: string }> = {
  applied: { icon: 'check', text: 'Applied', cls: 'good' }, rejected: { icon: 'close', text: 'Rejected', cls: 'muted' },
  comment: { icon: 'chat', text: 'Commented', cls: 'muted' }, failed: { icon: 'info', text: 'Failed', cls: 'bad' },
};

function RequestCard({ chatId, p, outcome, comment }: { chatId: string; p: PendingRequest; outcome?: string; comment?: string }) {
  const described = useDescribed(p.actions);
  const [note, setNote] = useState('');
  const active = !outcome;
  const busy = p.status === 'applying';
  const o = outcome ? OUTCOME[outcome] : null;
  return (
    <section className={'req-card' + (active ? ' active' : ' done')} aria-label={`Request: ${p.summary}`}>
      <div className="req-head">
        <span className="req-glyph" aria-hidden><Icon name="edit" size={16} stroke={2.2} /></span>
        <span className="grow req-summary" dir="auto">{p.summary}</span>
        {o && <span className={'req-outcome ' + o.cls}><Icon name={o.icon} size={14} stroke={2.6} />{o.text}</span>}
      </div>
      <div className="req-actions">
        {(described ?? p.actions.map((a) => ({ title: a.name, icon: 'bolt', rows: [] }))).map((d, i) => (
          <div key={i} className="req-action">
            <div className="req-action-title"><Icon name={d.icon} size={15} stroke={2.2} />{d.title}</div>
            {d.rows.length > 0 && (
              <dl className="req-rows">
                {d.rows.map((r, j) => <div key={j}><dt dir="auto">{r.label}</dt><dd dir="auto" className="num">{r.value}</dd></div>)}
              </dl>
            )}
          </div>
        ))}
      </div>
      {comment && <p className="req-comment" dir="auto">“{comment}”</p>}
      {active && (
        <>
          <label className="req-note">
            <span className="sr-only">Comment</span>
            <input className="input" placeholder="Comment (optional)" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { e.preventDefault(); void resolvePending(chatId, { type: 'comment', comment: note }); } }} />
            {note.trim() && <button className="icon-btn sm tint" aria-label="Send comment" disabled={busy} onClick={() => resolvePending(chatId, { type: 'comment', comment: note })}><Icon name="arrowUp" size={18} stroke={2.4} /></button>}
          </label>
          <div className="req-buttons">
            <button className="btn lg" disabled={busy} onClick={() => resolvePending(chatId, { type: 'reject', comment: note })}><Icon name="close" size={18} stroke={2.4} />Reject</button>
            <button className="btn lg good" disabled={busy} onClick={() => resolvePending(chatId, { type: 'apply' })}><Icon name="check" size={18} stroke={2.6} />{busy ? 'Applying…' : 'Apply'}</button>
          </div>
        </>
      )}
    </section>
  );
}

function Composer({ chat, running }: { chat: Chat; running: boolean }) {
  const [text, setText] = useState('');
  const [imgs, setImgs] = useState<Extract<AIPart, { type: 'image' }>[]>([]);
  const [busyImg, setBusyImg] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const loc = useLocation();
  const pending = chat.pending?.status === 'pending';
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; } }, [text]);
  const canSend = !running && (!!text.trim() || (!pending && imgs.length > 0)) && !busyImg;
  const send = async () => {
    if (!canSend) return;
    const parts: AIPart[] = [...imgs, ...(text.trim() ? [{ type: 'text' as const, text: text.trim() }] : [])];
    setText(''); setImgs([]);
    const fresh = await getChat(chat.id);
    await sendMessage(chat.id, parts, fresh?.context ?? { route: loc.pathname, date: dateKey() });
  };
  return (
    <div className="composer-wrap">
      {imgs.length > 0 && (
        <div className="composer-imgs">
          {imgs.map((im, i) => (
            <span key={i} className="composer-img">
              <img alt={`Photo ${i + 1}`} src={`data:${im.mime};base64,${im.base64}`} />
              <button aria-label={`Remove photo ${i + 1}`} onClick={() => setImgs((x) => x.filter((_, j) => j !== i))}><Icon name="close" size={12} stroke={3} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <label className="icon-btn composer-btn" aria-label="Add photo">
          <Icon name="camera" size={22} />
          <input type="file" accept="image/*" className="sr-only" disabled={running} onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            setBusyImg(true);
            try { const im = await downscaleImage(f); setImgs((x) => [...x, im].slice(-4)); }
            catch { await notice('Couldn’t read that photo', 'Try another photo, or a screenshot of it.'); }
            finally { setBusyImg(false); }
          }} />
        </label>
        <textarea ref={ta} rows={1} className="composer-input" dir="auto" value={text} placeholder={pending ? 'Comment on the request…' : 'Message'} aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); void send(); } }} />
        <AnimatePresence initial={false} mode="popLayout">
          {running ? (
            <motion.button key="stop" className="send-btn stop" aria-label="Stop" onClick={() => stop(chat.id)} {...swap}><Icon name="stop" size={16} stroke={3} /></motion.button>
          ) : (
            <motion.button key="send" className="send-btn" aria-label="Send" disabled={!canSend} onClick={send} {...swap}><Icon name="arrowUp" size={20} stroke={2.6} /></motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
const swap = { initial: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }, animate: { scale: 1, opacity: 1, filter: 'blur(0px)' }, exit: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }, transition: { type: 'spring', duration: 0.3, bounce: 0 } } as const;

/** Floating button on every screen except the agent itself and a live workout. Opens a chat with this screen as context. */
export function AgentFab({ hidden }: { hidden?: boolean }): ReactNode {
  const { pathname, search } = useLocation();
  const nav = useNavigate();
  if (hidden || pathname.startsWith('/agent') || pathname.startsWith('/session/')) return null;
  const d = new URLSearchParams(search).get('d') ?? dateKey();
  return (
    <button className="agent-fab pressable" aria-label="Ask the assistant"
      onClick={() => nav(`/agent/new?from=${encodeURIComponent(pathname + search)}&d=${d}`)}>
      <Icon name="sparkle" size={24} stroke={1.9} />
    </button>
  );
}
