import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { AskCard, RequestBlockCard } from '../components/AgentCards';
import { DisplayCard } from '../components/AgentChart';
import { MemoryList } from '../components/AgentSettings';
import { confirmDialog, notice } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { VoiceCallButton } from '../components/VoiceCall';
import { useSync } from '../lib/sync';
import { isFake } from '../lib/agent/client';
import { AttachError, fileToParts } from '../lib/agent/attach';
import { deleteChat, getChat, keepChat, newChat, renameChat, setChatContext, setChatFields, useChat, useChats } from '../lib/agent/chats';
import { isContextPart } from '../lib/agent/instructions';
import { cachedStatus, needsReply, recoverChat, runLoop, sendMessage, stop, useLive } from '../lib/agent/loop';
import { setQuickChat, useQuickChat } from '../lib/agent/quick';
import { chipLabel } from '../lib/agent/tools';
import type { AIMessage, AIPart, AIStatus, AIToolCall, AgentContext, Chat, ProviderId } from '../lib/agent/types';
import { dateKey } from '../lib/nutrition';

const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const lastText = (c: Chat) => {
  for (let i = c.messages.length - 1; i >= 0; i--) { const m = c.messages[i]; if (m.role === 'assistant' && m.text) return m.text; }
  return '';
};
const spring = { type: 'spring', bounce: 0, duration: 0.35 } as const;

/** /agent — chat history. Quick chats (photo logging etc.) sit behind the Quick filter and expire after 3 days. */
export function AgentPage() {
  const nav = useNavigate();
  const all = (useChats() ?? []).filter((c) => c.messages.length);
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'quick' ? 'quick' : 'chats';
  const quickCount = all.filter((c) => c.kind === 'quick').length;
  const [menu, setMenu] = useState<Chat | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [olderOpen, setOlderOpen] = useState(false);
  const [q, setQ] = useState('');
  const sync = useSync();
  const ready = isFake() || !!sync.account;
  const inView = all.filter((c) => (c.kind === 'quick') === (view === 'quick'));
  const needle = q.trim().toLowerCase();
  const chats = needle ? inView.filter((c) => c.title.toLowerCase().includes(needle) || lastText(c).toLowerCase().includes(needle)) : inView;
  // chats untouched for a week fold into "Older" (quick chats are purged after 3 days anyway)
  const weekAgo = Date.now() - 7 * 864e5;
  const recent = view === 'quick' || needle ? chats : chats.filter((c) => c.updatedAt >= weekAgo);
  const older = view === 'quick' || needle ? [] : chats.filter((c) => c.updatedAt < weekAgo);
  const shown = [...recent, ...(olderOpen || selecting ? older : [])];
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const endSelect = () => { setSelecting(false); setPicked(new Set()); };
  const allPicked = shown.length > 0 && shown.every((c) => picked.has(c.id));
  const row = (c: Chat) => (
    <div key={c.id} className={'list-item chat-row' + (selecting && picked.has(c.id) ? ' picked' : '')}>
      {selecting && (
        <button className={'sel-circle' + (picked.has(c.id) ? ' on' : '')} aria-pressed={picked.has(c.id)} aria-label={`Select ${c.title}`} onClick={() => toggle(c.id)}>
          {picked.has(c.id) && <Icon name="check" size={14} stroke={3} />}
        </button>
      )}
      {selecting
        ? <button className="grow plain chat-row-main" onClick={() => toggle(c.id)}><ChatRowText c={c} /></button>
        : <Link to={`/agent/${c.id}`} className="grow plain chat-row-main"><ChatRowText c={c} /></Link>}
      {!selecting && <button className="icon-btn sm" aria-label={`Options for ${c.title}`} onClick={() => setMenu(c)}><Icon name="more" size={20} stroke={2.6} /></button>}
    </div>
  );
  return (
    <div className="page">
      <header className="page-head">
        <h1>Agent</h1>
        {inView.length > 0 && (selecting
          ? <button className="pill-btn" onClick={endSelect}>Done</button>
          : <button className="pill-btn" onClick={() => setSelecting(true)}>Select</button>)}
        {!selecting && <button className="icon-btn filled" aria-label="New chat" onClick={() => nav('/agent/new')}><Icon name="plus" size={22} stroke={2.2} /></button>}
      </header>
      {!ready && (
        <Link to="/settings" className="list-item pressable card agent-setup">
          <span className="role-chip lg" aria-hidden><Icon name="info" size={18} stroke={2} /></span>
          <span className="grow"><span className="title">Set up first</span><span className="sub" style={{ display: 'block' }}>Sign in (Back up & sync), then connect ChatGPT or OpenRouter in Settings → Agent</span></span>
          <Icon name="chevronRight" className="chev" size={18} />
        </Link>
      )}
      {all.length > 10 && (
        <label className="search" style={{ marginBottom: 12 }}>
          <Icon name="search" size={18} /><input className="input" type="search" placeholder="Search chats" aria-label="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      {(quickCount > 0 || view === 'quick') && (
        <div className="seg chat-filter" role="tablist" aria-label="Show">
          <button role="tab" aria-selected={view === 'chats'} onClick={() => { endSelect(); setParams({}, { replace: true }); }}>Chats</button>
          <button role="tab" aria-selected={view === 'quick'} onClick={() => { endSelect(); setParams({ view: 'quick' }, { replace: true }); }}>Quick{quickCount ? ` · ${quickCount}` : ''}</button>
        </div>
      )}
      {view === 'quick' && <p className="faint t-13" style={{ margin: '0 4px 8px' }}>Photo logs and other quick chats. Deleted after 3 days unless you keep them.</p>}
      {selecting && shown.length > 0 && (
        <button className="link" style={{ padding: '0 4px 8px' }} onClick={() => setPicked(allPicked ? new Set() : new Set(shown.map((c) => c.id)))}>{allPicked ? 'Select none' : 'Select all'}</button>
      )}
      {recent.length > 0 && <div className="list">{recent.map(row)}</div>}
      {older.length > 0 && (
        <>
          <button className="older-row pressable" aria-expanded={olderOpen || selecting} onClick={() => setOlderOpen((o) => !o)}>
            <span className="grow">Older</span><span className="faint num">{older.length}</span>
            <Icon name={olderOpen || selecting ? 'chevronUp' : 'chevronDown'} size={18} className="chev" />
          </button>
          {(olderOpen || selecting) && <div className="list">{older.map(row)}</div>}
        </>
      )}
      {!chats.length && (needle ? <div className="empty compact"><p>No chats match “{q}”.</p></div> : view === 'quick' ? (
        <div className="empty compact"><p>No quick chats.</p></div>
      ) : (
        <div className="empty">
          <Icon name="sparkle" size={44} stroke={1.6} />
          <h3>Ask Tap In</h3>
          <p>Log food from a photo, check your progress, plan a workout. Changes ask first.</p>
          <button className="btn primary" onClick={() => nav('/agent/new')}><Icon name="plus" size={18} stroke={2.4} />New chat</button>
        </div>
      ))}
      {!selecting && <Link to="/agent/memory" className="link" style={{ marginTop: 12 }}><Icon name="note" size={18} />Memory</Link>}
      {selecting && document.querySelector('.shell') && createPortal(
        <div className="sel-bar chat-sel-bar" role="toolbar" aria-label="Selected chats">
          <span className="sel-count num" aria-live="polite">{picked.size}<span className="sr-only"> selected</span></span>
          <span className="grow" />
          <button className="sel-act danger" disabled={!picked.size} onClick={async () => {
            const n = picked.size;
            if (!(await confirmDialog({ title: `Delete ${n} chat${n === 1 ? '' : 's'}?`, message: 'Memories and journal entries they saved stay.', confirm: 'Delete', danger: true }))) return;
            for (const id of picked) await deleteChat(id);
            endSelect();
          }}><Icon name="trash" size={20} /><span>Delete{picked.size ? ` ${picked.size}` : ''}</span></button>
        </div>, document.querySelector('.shell')!,
      )}
      <ChatMenu chat={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
function ChatRowText({ c }: { c: Chat }) {
  return (
    <>
      <span className="row" style={{ gap: 6 }}>
        <span className="title ellipsis grow" dir="auto">{c.title}</span>
        {c.pending?.status === 'pending' && !c.pending.answered && <span className="badge accent">Waiting</span>}
        <span className="faint t-13 num">{ago(c.updatedAt)}</span>
      </span>
      <span className="sub ellipsis" dir="auto" style={{ display: 'block' }}>{lastText(c) || ' '}</span>
    </>
  );
}

/** /agent/memory — what the assistant remembers. */
export function AgentMemoryPage() {
  const nav = useNavigate();
  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" aria-label="Back" onClick={() => nav(-1)}><Icon name="chevronLeft" size={24} /></button>
        <h1>Memory</h1>
      </header>
      <p className="faint t-13" style={{ margin: '-4px 4px 10px' }}>Facts the assistant saved about you. It reads the names every time and the notes when they matter.</p>
      <MemoryList />
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

// ---- model chip: which provider this chat uses (the only user choice; effort is the admin's) ----
function useStatus() {
  const [st, setSt] = useState<AIStatus | null>(null);
  useEffect(() => { let live = true; cachedStatus().then((s) => live && setSt(s)); return () => { live = false; }; }, []);
  return st;
}
/** "GPT-6.1 Sol" → "Sol", "GLM 5.3 Flash" → "GLM Flash": drop version tokens. */
const shortModel = (label: string) => label.split(/\s+/).filter((w) => !/\d/.test(w)).join(' ') || label;
function pickOf(chat: Chat, st: AIStatus | null) {
  const connected = st?.providers.filter((p) => p.connected) ?? [];
  const provider = connected.find((p) => p.id === chat.provider) ?? connected.find((p) => p.id === st?.config.primary) ?? connected[0];
  return { connected, provider };
}
const PLAN: Record<ProviderId, string> = { chatgpt: 'ChatGPT plan', openrouter: 'OpenRouter' };
function ModelChip({ chat, onOpen }: { chat: Chat; onOpen: () => void }) {
  const st = useStatus();
  const { connected, provider } = pickOf(chat, st);
  const ranLabel = chat.ran && st?.providers.find((p) => p.id === chat.ran!.provider && p.model === chat.ran!.model)?.label;
  const label = ranLabel && chat.ran!.provider === provider?.id ? ranLabel : provider?.label;
  if (!label) return null;
  if (connected.length < 2) return <span className="model-chip static"><Icon name="sparkle" size={12} stroke={2.4} />{shortModel(label)}</span>;
  return <button className="model-chip" onClick={onOpen} aria-label={`Using ${label} (${PLAN[provider!.id]}). Change`}><Icon name="sparkle" size={12} stroke={2.4} />{shortModel(label)}<Icon name="chevronDown" size={12} stroke={2.6} /></button>;
}
function ModelSheet({ chat, open, onClose }: { chat: Chat; open: boolean; onClose: () => void }) {
  const st = useStatus();
  const { connected, provider } = pickOf(chat, st);
  return (
    <Sheet open={open} onClose={onClose} title="Use">
      <div className="menu-group" style={{ marginTop: 0 }} role="radiogroup" aria-label="Provider">
        {connected.map((p) => (
          <button key={p.id} className="menu-item" role="radio" aria-checked={provider?.id === p.id} onClick={() => { void setChatFields(chat.id, { provider: p.id }); onClose(); }}>
            <Icon name={p.id === 'chatgpt' ? 'sparkle' : 'bolt'} size={22} />
            <span className="grow"><span style={{ display: 'block' }}>{PLAN[p.id]}</span><span className="faint t-13" style={{ fontWeight: 500 }}>{p.label}{p.video ? ' · video' : ''}</span></span>
            {provider?.id === p.id && <Icon name="check" size={20} stroke={2.6} />}
          </button>
        ))}
      </div>
      <p className="faint t-13" style={{ margin: '10px 4px 0' }}>For this chat. The other one takes over if this one fails.</p>
    </Sheet>
  );
}

/** /agent/:id — one chat, full screen: glass header, its own scroller, composer at the bottom. */
export function AgentChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const chat = useChat(id);
  const [menu, setMenu] = useState<Chat | null>(null);
  const [model, setModel] = useState(false);
  if (chat === undefined && id) return <div className="page" />;
  if (!chat) return <div className="page"><header className="page-head"><h1>Agent</h1></header><p className="muted">This chat no longer exists.</p></div>;
  return (
    <div className="chat-screen">
      <header className="chat-bar">
        <button className="glass-btn" aria-label="All chats" onClick={() => nav(chat.kind === 'quick' ? '/agent?view=quick' : '/agent')}><Icon name="chevronLeft" size={22} stroke={2.2} /></button>
        <div className="chat-bar-mid">
          <h1 className="chat-title ellipsis" dir="auto">{chat.messages.length ? chat.title : 'New chat'}</h1>
          <ModelChip chat={chat} onOpen={() => setModel(true)} />
        </div>
        <VoiceCallButton chat={chat} />
        {chat.messages.length > 0
          ? <button className="glass-btn" aria-label="Chat options" onClick={() => setMenu(chat)}><Icon name="more" size={22} stroke={2.6} /></button>
          : <span className="glass-btn ghost" aria-hidden />}
        <button className="glass-btn" aria-label="New chat" onClick={() => nav(`/agent/new?from=${encodeURIComponent(chat.context?.route ?? '/agent')}`)}><Icon name="plus" size={22} stroke={2.2} /></button>
      </header>
      <ChatBody chat={chat} />
      <ChatMenu chat={menu} onClose={() => setMenu(null)} />
      <ModelSheet chat={chat} open={model} onClose={() => setModel(false)} />
    </div>
  );
}

/** Messages + composer; used by the full-screen chat and the quick-chat sheet. */
function ChatBody({ chat }: { chat: Chat }) {
  const live = useLive(chat.id);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void recoverChat(chat.id); }, [chat.id]);
  // follow the conversation while the user is near the bottom
  // new messages / a new card always bring the bottom into view; streaming text only while the user is near it
  const count = chat.messages.length;
  const first = useRef(true);
  const seen = useRef('');
  const pinned = useRef(true); // the user hasn't scrolled away from the bottom
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const sig = `${count}|${chat.pending?.toolCallId ?? ''}|${chat.error ?? ''}|${live.running}`;
    const changed = sig !== seen.current; seen.current = sig;
    if (first.current || changed || box.scrollHeight - box.scrollTop - box.clientHeight < 260) { box.scrollTop = box.scrollHeight; pinned.current = true; }
    // cards fill in names/macros and images decode a moment later: re-pin a few times
    if (changed || first.current) for (const ms of [120, 400, 900]) window.setTimeout(() => { if (pinned.current) box.scrollTop = box.scrollHeight; }, ms);
    first.current = false;
  }, [count, live.text, live.running, chat.pending?.toolCallId, chat.error]);
  // stay pinned to the bottom while content grows (cards load names/macros, images decode) unless the user scrolled up
  useEffect(() => {
    const box = scroller.current, inner = box?.firstElementChild;
    if (!box || !inner) return;
    pinned.current = true;
    const onScroll = () => { pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80; };
    const ro = new ResizeObserver(() => { if (pinned.current) box.scrollTop = box.scrollHeight; });
    // the keyboard opening shrinks the scroller: keep the last message in view
    const onViewport = () => { if (pinned.current) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); };
    box.addEventListener('scroll', onScroll, { passive: true });
    window.visualViewport?.addEventListener('resize', onViewport);
    ro.observe(inner); ro.observe(box); // the box shrinks when the keyboard opens: keep the newest message in view
    return () => { ro.disconnect(); box.removeEventListener('scroll', onScroll); window.visualViewport?.removeEventListener('resize', onViewport); };
  }, [chat.id]);

  const results = new Map<string, string>();
  for (const m of chat.messages) if (m.role === 'tool') results.set(m.toolCallId, m.content);
  const showRetry = !live.running && (!!chat.error || needsReply(chat));
  const focusComposer = () => composer.current?.focus();
  return (
    <>
      <div className="chat-scroll" ref={scroller}>
        <div className="msgs" aria-live="polite" aria-busy={live.running}>
          {!chat.messages.length && <EmptyChat onPick={(t) => sendMessage(chat.id, [{ type: 'text', text: t }])} />}
          <AnimatePresence initial={false}>
            {chat.messages.map((m, i) => <Message key={i} m={m} chat={chat} results={results} onChange={focusComposer} />)}
          </AnimatePresence>
          {live.running && (live.text
            ? <div className="bubble bot streaming" dir="auto"><Rich text={live.text} /><span className="caret" aria-hidden /></div>
            : <motion.div className="typing" aria-label="Thinking" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={spring}><i /><i /><i /></motion.div>)}
          {chat.error && !live.running && <div className="chat-error" role="alert"><Icon name="info" size={16} stroke={2.2} /><span className="grow">{chat.error}</span></div>}
          {showRetry && <button className="btn chat-retry" onClick={() => runLoop(chat.id)}><Icon name="history" size={16} />Retry</button>}
        </div>
      </div>
      <Composer chat={chat} running={live.running} inputRef={composer} />
    </>
  );
}

function EmptyChat({ onPick }: { onPick: (t: string) => void }) {
  const ideas = ['How was my training this week?', 'What did I eat today?', 'Log 2 eggs for breakfast'];
  return (
    <div className="chat-empty">
      <span className="chat-empty-glyph" aria-hidden><Icon name="sparkle" size={30} stroke={1.7} /></span>
      <div className="stack" style={{ gap: 8, width: '100%' }}>
        {ideas.map((t) => <button key={t} className="idea pressable" onClick={() => onPick(t)}><span className="grow">{t}</span><Icon name="arrowUp" size={16} stroke={2.4} /></button>)}
      </div>
    </div>
  );
}

/** Minimal formatting: paragraphs, line breaks, **bold**. */
function Rich({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((s, i) => (s.startsWith('**') && s.endsWith('**') && s.length > 4 ? <b key={i}>{s.slice(2, -2)}</b> : <Fragment key={i}>{s}</Fragment>))}</>;
}

const bubbleIn = { initial: { opacity: 0, y: 10, scale: 0.96 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: spring };

function UserPart({ p }: { p: AIPart }) {
  if (p.type === 'image') return <img className="bubble-img" alt="Attached photo" src={`data:${p.mime};base64,${p.base64}`} />;
  if (p.type === 'file') return <span className="att-chip"><Icon name="note" size={16} />{p.name}</span>;
  if (p.type === 'video') return <span className="att-chip"><Icon name="play" size={16} />Video</span>;
  if (isContextPart(p.text)) return null;
  const file = p.text.match(/^\[File "(.+?)"/);
  if (file) return <span className="att-chip"><Icon name="note" size={16} />{file[1]}</span>;
  const video = p.text.match(/^\[Video "(.+?)"/);
  if (video) return <span className="att-chip"><Icon name="play" size={16} />{video[1]} · frames</span>;
  return <span className="bubble-text">{p.text}</span>;
}

function Message({ m, chat, results, onChange }: { m: AIMessage; chat: Chat; results: Map<string, string>; onChange: () => void }) {
  if (m.role === 'tool') {
    // a comment on a request card shows as the user's own bubble (the card stays open above it)
    if (m.name !== 'request_changes') return null;
    let r: { status?: string; comment?: string } = {};
    try { r = JSON.parse(m.content); } catch { /* not JSON */ }
    return r.status === 'comment' && r.comment ? <motion.div className="bubble user" dir="auto" {...bubbleIn}><span className="bubble-text">{r.comment}</span></motion.div> : null;
  }
  if (m.role === 'user') {
    const note = m.content.length === 1 && m.content[0].type === 'text' ? m.content[0].text.match(/^<context>user (applied|rejected) the earlier request "(.*?)"/) : null;
    if (note) return <div className="chat-note"><Icon name={note[1] === 'applied' ? 'check' : 'close'} size={13} stroke={2.6} />You {note[1]} “{note[2]}”</div>;
    if (!m.content.some((p) => p.type !== 'text' || !isContextPart(p.text))) return null;
    const imgs = m.content.filter((p) => p.type === 'image');
    const rest = m.content.filter((p) => p.type !== 'image');
    return (
      <motion.div className="bubble user" dir="auto" {...bubbleIn}>
        {imgs.length > 0 && <div className={'bubble-imgs' + (imgs.length > 1 ? ' grid' : '')}>{imgs.map((p, i) => <UserPart key={i} p={p} />)}</div>}
        {rest.map((p, i) => <UserPart key={i} p={p} />)}
      </motion.div>
    );
  }
  const calls = m.toolCalls ?? [];
  const CARD = ['request_changes', 'ask_user', 'show_chart', 'show_table', 'show_stats'];
  const chips = calls.filter((c) => !CARD.includes(c.name));
  return (
    <>
      {m.text && <motion.div className="bubble bot" dir="auto" {...bubbleIn}><Rich text={m.text} /></motion.div>}
      {chips.length > 0 && <div className="tool-chips">{chips.map((c) => <ToolChip key={c.id} call={c} failed={isError(results.get(c.id))} />)}</div>}
      {calls.filter((c) => CARD.includes(c.name)).map((c) => <CardBlock key={c.id} call={c} chat={chat} result={results.get(c.id)} onChange={onChange} />)}
    </>
  );
}
const isError = (content?: string) => { if (!content) return false; try { return 'error' in (JSON.parse(content) as object); } catch { return false; } };

function ToolChip({ call, failed }: { call: AIToolCall; failed?: boolean }) {
  const { icon, text } = chipLabel(call);
  return <span className={'tool-chip' + (failed ? ' failed' : '')}><Icon name={failed ? 'info' : icon} size={13} stroke={2.2} />{text}{failed ? ' · failed' : ''}</span>;
}

function CardBlock({ call, chat, result, onChange }: { call: AIToolCall; chat: Chat; result?: string; onChange: () => void }) {
  if (call.name.startsWith('show_')) {
    const d = chat.displays?.[call.id];
    if (d) return <DisplayCard d={d} />;
    return result && isError(result) ? <div className="tool-chips"><span className="tool-chip failed"><Icon name="info" size={13} stroke={2.2} />Couldn’t draw that · retrying</span></div> : null;
  }
  const p = chat.pending?.toolCallId === call.id ? chat.pending : null;
  const done = chat.cards?.[call.id];
  if (p?.kind === 'ask' || (!p && done?.kind === 'ask')) {
    const qs = p?.questions ?? done?.questions ?? [];
    return <AskCard chatId={chat.id} questions={qs} answered={p ? undefined : { answers: done?.answers, text: done?.comment }} />;
  }
  if (p) return <RequestBlockCard chatId={chat.id} p={p} onChange={onChange} />;
  if (done) return <RequestBlockCard chatId={chat.id} p={{ toolCallId: call.id, summary: done.summary, actions: done.actions, status: 'pending' }} outcome={done.outcome} comment={done.outcome === 'rejected' ? done.comment : undefined} />;
  if (result && isError(result)) return <div className="tool-chips"><span className="tool-chip failed"><Icon name="info" size={13} stroke={2.2} />{call.name === 'ask_user' ? 'Question' : 'Request'} didn’t validate · retrying</span></div>;
  return null;
}

// ---- composer: text, attach menu (photo / camera / video / file), send / stop ----
function Composer({ chat, running, inputRef }: { chat: Chat; running: boolean; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<{ label: string; kind: 'image' | 'file' | 'video'; parts: AIPart[] }[]>([]);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const st = useStatus();
  const loc = useLocation();
  const pending = chat.pending?.status === 'pending' && !chat.pending.answered;
  const ask = pending && chat.pending?.kind === 'ask';
  useLayoutEffect(() => { const el = inputRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; } }, [text, inputRef]);
  const canSend = !running && !busy && (!!text.trim() || (!pending && atts.length > 0));
  const send = async () => {
    if (!canSend) return;
    if (text.trim() === '/vvdebug') { // hidden: toggle the keyboard/viewport readout (iOS layout diagnosis)
      try { localStorage.setItem('tapin:vvdebug', localStorage.getItem('tapin:vvdebug') === '1' ? '0' : '1'); } catch { /* ignore */ }
      setText(''); window.visualViewport?.dispatchEvent(new Event('resize')); return;
    }
    const parts: AIPart[] = [...atts.flatMap((a) => a.parts), ...(text.trim() ? [{ type: 'text' as const, text: text.trim() }] : [])];
    setText(''); setAtts([]);
    const fresh = await getChat(chat.id);
    await sendMessage(chat.id, parts, fresh?.context ?? { route: loc.pathname, date: dateKey() });
  };
  const add = async (files: FileList | null) => {
    setMenu(false);
    const list = [...(files ?? [])].slice(0, 4);
    if (!list.length) return;
    setBusy(true);
    const { provider } = pickOf(chat, st);
    try {
      for (const f of list) {
        const parts = await fileToParts(f, { video: !!provider?.video });
        const kind: 'image' | 'file' | 'video' = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'file';
        setAtts((x) => [...x, { label: f.name, kind, parts }].slice(-4));
      }
    } catch (e) { await notice('Couldn’t attach that', e instanceof AttachError ? e.message : 'Try another file.'); }
    finally { setBusy(false); }
  };
  const placeholder = ask ? 'Or answer in your words…' : pending ? 'What should change?' : 'Message';
  return (
    <div className="composer-wrap">
      {atts.length > 0 && (
        <div className="composer-imgs">
          {atts.map((a, i) => {
            const img = a.parts.find((p) => p.type === 'image') as Extract<AIPart, { type: 'image' }> | undefined;
            return (
              <span key={i} className="composer-img">
                {a.kind === 'image' && img ? <img alt={a.label} src={`data:${img.mime};base64,${img.base64}`} /> : <span className="composer-file"><Icon name={a.kind === 'video' ? 'play' : 'note'} size={18} /><span className="ellipsis">{a.label}</span></span>}
                <button aria-label={`Remove ${a.label}`} onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}><Icon name="close" size={12} stroke={3} /></button>
              </span>
            );
          })}
        </div>
      )}
      <div className="composer">
        <button className="composer-btn" aria-label="Attach" aria-haspopup="dialog" disabled={running || busy} onClick={() => setMenu(true)}><Icon name={busy ? 'more' : 'plus'} size={22} stroke={2.2} /></button>
        <textarea ref={inputRef} rows={1} className="composer-input" dir="auto" value={text} placeholder={placeholder} aria-label="Message"
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
      <Sheet open={menu} onClose={() => setMenu(false)} title="Attach">
        <div className="attach-grid">
          <AttachOption icon="image" label="Photo" accept="image/*" multiple onPick={add} />
          <AttachOption icon="camera" label="Camera" accept="image/*" capture onPick={add} />
          <AttachOption icon="play" label="Video" accept="video/*" onPick={add} />
          <AttachOption icon="note" label="File" accept="application/pdf,text/plain,text/csv,text/markdown,application/json,.csv,.json,.md,.txt,.tsv" onPick={add} />
        </div>
        <p className="faint t-13" style={{ margin: '12px 4px 0' }}>PDFs up to 10 MB, videos up to 20 MB. Text files are read in.</p>
      </Sheet>
    </div>
  );
}
function AttachOption({ icon, label, accept, capture, multiple, onPick }: { icon: string; label: string; accept: string; capture?: boolean; multiple?: boolean; onPick: (f: FileList | null) => void }) {
  return (
    <label className="attach-opt pressable">
      <span className="attach-ic" aria-hidden><Icon name={icon} size={24} stroke={2} /></span>
      <span>{label}</span>
      <input type="file" className="sr-only" accept={accept} multiple={multiple} {...(capture ? { capture: 'environment' as const } : {})}
        onChange={(e) => { const f = e.target.files; onPick(f); e.target.value = ''; }} />
    </label>
  );
}
const swap = { initial: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }, animate: { scale: 1, opacity: 1, filter: 'blur(0px)' }, exit: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }, transition: { type: 'spring', duration: 0.3, bounce: 0 } } as const;

/** Quick chats (lib/agent/quick.ts) open here, as a sheet over the current page. */
export function QuickChatHost() {
  const id = useQuickChat();
  const chat = useChat(id ?? undefined);
  const nav = useNavigate();
  const [model, setModel] = useState(false);
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
      {chat && (
        <div className="quick-chat">
          <div className="quick-model"><ModelChip chat={chat} onOpen={() => setModel(true)} /></div>
          <ChatBody chat={chat} />
          <ModelSheet chat={chat} open={model} onClose={() => setModel(false)} />
        </div>
      )}
    </Sheet>
  );
}

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
