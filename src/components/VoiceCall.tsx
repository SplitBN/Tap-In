// Voice call UI (contract v4): the call button for the chat header and the full-screen call. The call screen keeps
// the chat visible (the agent still suggests things on screen): orb + status on top, the live chat feed with its
// cards (food log, requests, questions, charts — actionable) in the middle, controls at the bottom. Camera: preview,
// shutter (photo goes with the next thing you say, or "Send now"), Live (a few frames while you speak).
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { AskCard, RequestBlockCard } from './AgentCards';
import { DisplayCard } from './AgentChart';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { isFake } from '../lib/agent/client';
import { useChat } from '../lib/agent/chats';
import { isContextPart } from '../lib/agent/instructions';
import { cachedStatus, useLive } from '../lib/agent/loop';
import { chipLabel } from '../lib/agent/tools';
import type { AIMessage, AIPart, AIStatus, AIToolCall, Chat } from '../lib/agent/types';
import { unlockAudio } from '../lib/voice/audio';
import { VoiceCall, type CallState } from '../lib/voice/call';
import './VoiceCall.css';

// ---- icons (stroke, currentColor) ----
const P: Record<string, ReactNode> = {
  phone: <path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  end: <path d="M3.5 14.5c4.7-4.2 12.3-4.2 17 0l-2 2.6-3.6-1.3-.4-2.4a10 10 0 0 0-5 0l-.4 2.4-3.6 1.3z" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>,
  micOff: <><path d="M15 10V6a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 4.7 2.5M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11a6.5 6.5 0 0 1-.6 2.7M12 17.5V21M4 4l16 16" /></>,
  camera: <><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="12.5" r="3.5" /></>,
  flip: <><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M9 12.5a3 3 0 0 1 5.2-2M15 12.5a3 3 0 0 1-5.2 2M14.5 8.8v1.9h-1.9M9.5 16.2v-1.9h1.9" /></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 14h10" /></>,
  live: <><circle cx="12" cy="12" r="3" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" /></>,
};
function VIcon({ name, size = 24, stroke = 2 }: { name: keyof typeof P; size?: number; stroke?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{P[name]}</svg>;
}

/** Header button. Creates the AudioContext inside the tap (iOS unlocks audio only in a gesture), then opens the call. */
export function VoiceCallButton({ chat }: { chat: Chat }) {
  const [st, setSt] = useState<AIStatus | null>(null);
  const [call, setCall] = useState<VoiceCall | null>(null);
  const [needKey, setNeedKey] = useState(false);
  useEffect(() => { let on = true; cachedStatus().then((s) => on && setSt(s)); return () => { on = false; }; }, []);
  const start = () => {
    if (!isFake() && st && !st.openrouter.hasKey) { setNeedKey(true); return; }
    const ctx = unlockAudio(); // synchronous, before anything async
    setCall(new VoiceCall(chat.id, ctx));
  };
  return (
    <>
      <button className="glass-btn" aria-label="Voice call" onClick={start}><VIcon name="phone" size={20} stroke={2.1} /></button>
      {call && <CallScreen key={chat.id} call={call} onClose={() => setCall(null)} />}
      <Sheet open={needKey} onClose={() => setNeedKey(false)} title="Voice calls">
        <p className="muted" style={{ margin: '0 4px 14px' }}>Talking uses speech models on OpenRouter, so it needs your OpenRouter key. A call costs a few cents.</p>
        <Link to="/settings" className="btn lg block primary" onClick={() => setNeedKey(false)}>Add key in Settings → Agent</Link>
      </Sheet>
    </>
  );
}

const STATUS: Record<CallState, string> = {
  starting: 'Connecting…', listening: 'Listening', hearing: 'Hearing you…', transcribing: 'Got it…', thinking: 'Thinking…', speaking: 'Talk anytime to interrupt', muted: 'Muted', ended: 'Call ended',
};

function CallScreen({ call, onClose }: { call: VoiceCall; onClose: () => void }) {
  const snap = useSyncExternalStore(call.subscribe, call.getSnapshot);
  const chat = useChat(call.chatId);
  const live = useLive(call.chatId);
  const reduce = useReducedMotion();
  const [muted, setMuted] = useState(false);
  const [typing, setTyping] = useState(isFake());
  const [text, setText] = useState('');
  const [secs, setSecs] = useState(0);
  const cam = useCamera(call);

  useEffect(() => { void call.start(); return () => call.endSoon(); }, [call]);
  useEffect(() => { const t0 = Date.now(); const t = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (snap.state === 'ended') { const t = setTimeout(onClose, snap.error ? 1600 : 0); return () => clearTimeout(t); } }, [snap.state, snap.error, onClose]);
  // debug / tests: window.tapinVoice.say('log two eggs')
  useEffect(() => {
    const w = window as unknown as { tapinVoice?: unknown };
    w.tapinVoice = { say: (t: string) => call.sendText(t), state: () => call.getSnapshot(), call };
    return () => { delete w.tapinVoice; };
  }, [call]);

  const hangUp = () => { call.end(); };
  const toggleMute = () => { const m = !muted; setMuted(m); call.setMuted(m); };
  const showTyping = typing || !snap.micOk;
  const host = document.querySelector('.shell') ?? document.body;
  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return createPortal(
    <motion.div className={`vc-screen s-${snap.state}`} role="dialog" aria-modal="true" aria-label="Voice call"
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', bounce: 0, duration: 0.35 }}>
      <header className="vc-top">
        <span className="vc-title ellipsis" dir="auto">{chat?.title && chat.messages.length ? chat.title : 'Tap In'}</span>
        <span className="vc-time num" aria-label={`Call time ${mm}`}>{mm}</span>
      </header>

      <div className={'vc-stage' + (cam.on ? ' cam' : '')}>
        {cam.on && <video ref={cam.video} className={'vc-video' + (cam.facing === 'user' ? ' mirror' : '')} playsInline muted autoPlay aria-label="Camera preview" />}
        <Orb call={call} small={cam.on} />
        <div className="vc-status" aria-live="polite">
          <span className="vc-state">{!snap.micOk && snap.state === 'listening' ? 'Type to talk' : STATUS[snap.state]}</span>
          {snap.state === 'speaking' && snap.agent ? <span className="vc-caption" dir="auto">{snap.agent}</span>
            : snap.you && (snap.state === 'thinking' || snap.state === 'transcribing' || snap.state === 'hearing') ? <span className="vc-caption you" dir="auto">“{snap.you}”</span> : null}
          {snap.debug && <span className="vc-debug faint t-13">{snap.debug}</span>}
        </div>
      </div>

      <Feed chat={chat} liveText={live.running ? live.text : ''} thinking={live.running && !live.text} />

      {snap.error && <div className="vc-error" role="alert"><Icon name="info" size={15} stroke={2.2} /><span className="grow">{snap.error}</span></div>}
      <AnimatePresence>
        {snap.photos > 0 && (
          <motion.div className="vc-photo" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.15 }}>
            {cam.lastShot && <img src={cam.lastShot} alt="Photo to send" />}
            <span className="grow">{snap.photos > 1 ? `${snap.photos} photos` : 'Photo'} goes with what you say next</span>
            <button className="pill-btn" onClick={() => call.sendPhotosNow()}>Send now</button>
            <button className="icon-btn sm" aria-label="Discard photo" onClick={() => call.clearPhotos()}><Icon name="close" size={16} stroke={2.6} /></button>
          </motion.div>
        )}
      </AnimatePresence>
      {showTyping && (
        <form className="vc-type" onSubmit={(e) => { e.preventDefault(); call.sendText(text); setText(''); }}>
          <input className="input grow" dir="auto" value={text} placeholder={snap.micOk ? 'Type instead…' : 'Type your message…'} aria-label="Message" onChange={(e) => setText(e.target.value)} />
          <button className="send-btn" aria-label="Send" disabled={!text.trim()}><Icon name="arrowUp" size={20} stroke={2.6} /></button>
        </form>
      )}

      {cam.on && (
        <div className="vc-camrow">
          <button className={'vc-chip' + (cam.live ? ' on' : '')} aria-pressed={cam.live} onClick={cam.toggleLive}><VIcon name="live" size={18} />Live{cam.live && snap.frames ? ` · ${snap.frames}` : ''}</button>
          <button className="vc-shutter" aria-label="Take photo" onClick={cam.shoot}><span /></button>
          <button className="vc-chip" aria-label="Switch camera" onClick={cam.flip}><VIcon name="flip" size={18} />Flip</button>
        </div>
      )}
      <div className="vc-controls">
        <button className={'vc-btn' + (muted ? ' on' : '')} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} disabled={!snap.micOk}>
          <VIcon name={muted ? 'micOff' : 'mic'} /><span>{muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button className={'vc-btn' + (cam.on ? ' on' : '')} aria-pressed={cam.on} aria-label={cam.on ? 'Camera off' : 'Camera on'} onClick={cam.toggle}>
          <VIcon name="camera" /><span>Camera</span>
        </button>
        <button className={'vc-btn' + (typing ? ' on' : '')} aria-pressed={typing} aria-label="Type" onClick={() => setTyping((t) => !t)}>
          <VIcon name="keyboard" /><span>Type</span>
        </button>
        <button className="vc-btn end" aria-label="End call" onClick={hangUp}><VIcon name="end" size={28} stroke={2.2} /><span>End</span></button>
      </div>
      {cam.error && <p className="vc-camerr faint t-13">{cam.error}</p>}
    </motion.div>,
    host,
  );
}

/** The orb: reacts to the mic while you talk and to the voice while the agent talks. Levels are read every frame
 *  and written to CSS variables (no React renders per frame). */
function Orb({ call, small }: { call: VoiceCall; small: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0, mic = 0, agent = 0;
    const tick = () => {
      const l = call.levels();
      mic += (Math.min(1, l.mic * 9) - mic) * 0.25;
      agent += (Math.min(1, l.agent * 6) - agent) * 0.3;
      ref.current?.style.setProperty('--mic', mic.toFixed(3));
      ref.current?.style.setProperty('--agent', agent.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [call]);
  return (
    <div ref={ref} className={'vc-orb' + (small ? ' small' : '')} aria-hidden>
      <i className="ring" /><i className="glow" /><i className="core" />
    </div>
  );
}

// ---- the chat, compact: bubbles + cards (actionable) ----
const CARD = ['request_changes', 'ask_user', 'show_chart', 'show_table', 'show_stats'];
function Feed({ chat, liveText, thinking }: { chat: Chat | undefined; liveText: string; thinking: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const count = chat?.messages.length ?? 0;
  useLayoutEffect(() => { const b = box.current; if (b && pinned.current) b.scrollTop = b.scrollHeight; }, [count, liveText, chat?.pending?.toolCallId]);
  useEffect(() => {
    const b = box.current, inner = b?.firstElementChild;
    if (!b || !inner) return;
    const onScroll = () => { pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
    const ro = new ResizeObserver(() => { if (pinned.current) b.scrollTop = b.scrollHeight; });
    ro.observe(inner); b.addEventListener('scroll', onScroll, { passive: true });
    return () => { ro.disconnect(); b.removeEventListener('scroll', onScroll); };
  }, []);
  if (!chat) return <div className="vc-feed" />;
  const results = new Map<string, string>();
  for (const m of chat.messages) if (m.role === 'tool') results.set(m.toolCallId, m.content);
  return (
    <div className="vc-feed" ref={box} aria-label="Conversation">
      <div className="vc-msgs">
        {!chat.messages.length && <p className="vc-hint">Say hi, ask about your training, or “log two eggs for breakfast”. Cards show up here.</p>}
        {chat.messages.map((m, i) => <FeedMessage key={i} m={m} chat={chat} results={results} />)}
        {liveText && <div className="bubble bot vc-b" dir="auto">{plain(liveText)}</div>}
        {thinking && <div className="typing vc-typing" aria-label="Thinking"><i /><i /><i /></div>}
        {chat.error && <div className="chat-error" role="alert"><Icon name="info" size={16} stroke={2.2} /><span className="grow">{chat.error}</span></div>}
      </div>
    </div>
  );
}
const plain = (t: string) => t.replace(/\*\*([^*]+)\*\*/g, '$1');

function FeedMessage({ m, chat, results }: { m: AIMessage; chat: Chat; results: Map<string, string> }) {
  if (m.role === 'tool') {
    if (m.name !== 'request_changes') return null;
    let r: { status?: string; comment?: string } = {};
    try { r = JSON.parse(m.content); } catch { /* not JSON */ }
    return r.status === 'comment' && r.comment ? <div className="bubble user vc-b" dir="auto">{r.comment}</div> : null;
  }
  if (m.role === 'user') {
    const note = m.content.length === 1 && m.content[0].type === 'text' ? m.content[0].text.match(/^<context>user (applied|rejected) the earlier request "(.*?)"/) : null;
    if (note) return <div className="chat-note"><Icon name={note[1] === 'applied' ? 'check' : 'close'} size={13} stroke={2.6} />You {note[1]} “{note[2]}”</div>;
    const imgs = m.content.filter((p): p is Extract<AIPart, { type: 'image' }> => p.type === 'image');
    const texts = m.content.filter((p): p is Extract<AIPart, { type: 'text' }> => p.type === 'text' && !isContextPart(p.text));
    if (!imgs.length && !texts.length) return null;
    return (
      <div className="bubble user vc-b" dir="auto">
        {imgs.length > 0 && <span className="vc-imgs">{imgs.map((p, i) => <img key={i} alt="Sent photo" src={`data:${p.mime};base64,${p.base64}`} />)}</span>}
        {texts.map((p, i) => <Fragment key={i}>{p.text}</Fragment>)}
      </div>
    );
  }
  const calls = m.toolCalls ?? [];
  const chips = calls.filter((c) => !CARD.includes(c.name));
  return (
    <>
      {m.text && <div className="bubble bot vc-b" dir="auto">{plain(m.text)}</div>}
      {chips.length > 0 && <div className="tool-chips">{chips.map((c) => { const { icon, text } = chipLabel(c); return <span key={c.id} className="tool-chip"><Icon name={icon} size={13} stroke={2.2} />{text}</span>; })}</div>}
      {calls.filter((c) => CARD.includes(c.name)).map((c) => <FeedCard key={c.id} call={c} chat={chat} result={results.get(c.id)} />)}
    </>
  );
}

function FeedCard({ call, chat, result }: { call: AIToolCall; chat: Chat; result?: string }) {
  if (call.name.startsWith('show_')) { const d = chat.displays?.[call.id]; return d ? <div className="vc-card"><DisplayCard d={d} /></div> : null; }
  const p = chat.pending?.toolCallId === call.id ? chat.pending : null;
  const done = chat.cards?.[call.id];
  if (p?.kind === 'ask' || (!p && done?.kind === 'ask')) {
    return <div className="vc-card"><AskCard chatId={chat.id} questions={p?.questions ?? done?.questions ?? []} answered={p ? undefined : { answers: done?.answers, text: done?.comment }} /></div>;
  }
  if (p) return <div className="vc-card"><RequestBlockCard chatId={chat.id} p={p} /></div>;
  if (done) return <div className="vc-card"><RequestBlockCard chatId={chat.id} p={{ toolCallId: call.id, summary: done.summary, actions: done.actions, status: 'pending' }} outcome={done.outcome} comment={done.outcome === 'rejected' ? done.comment : undefined} outcomes={done.outcomes} /></div>;
  void result;
  return null;
}

// ---- camera: preview, flip, shutter, live frames ----
function useCamera(call: VoiceCall) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [on, setOn] = useState(false);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [lastShot, setLastShot] = useState('');
  const stopStream = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  const open = async (f: 'environment' | 'user') => {
    stopStream();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: f }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => {}); }
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).name === 'NotAllowedError' ? 'Camera access is off. Allow it for Tap In in Settings.' : 'Camera unavailable.');
      return false;
    }
  };
  // attach the stream once the <video> mounts
  useEffect(() => { if (on && video.current && stream.current && video.current.srcObject !== stream.current) { video.current.srcObject = stream.current; void video.current.play().catch(() => {}); } });
  useEffect(() => () => { stopStream(); call.frameSource = null; }, [call]);
  const frame = (max = 768): AIPart | null => {
    const v = video.current;
    if (!v || !v.videoWidth) return null;
    const k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    const d = c.toDataURL('image/jpeg', 0.75);
    return { type: 'image', mime: 'image/jpeg', base64: d.slice(d.indexOf(',') + 1) };
  };
  call.frameSource = on ? () => frame() : null;
  return {
    video, on, facing, live, error, lastShot,
    toggle: async () => {
      if (on) { stopStream(); setOn(false); setLive(false); call.live = false; return; }
      setOn(true);
      if (!(await open(facing))) setOn(false);
    },
    flip: async () => { const f = facing === 'user' ? 'environment' : 'user'; setFacing(f); await open(f); },
    toggleLive: () => { const l = !live; setLive(l); call.live = l; },
    shoot: () => { const p = frame(); if (p && p.type === 'image') { call.addPhoto(p); setLastShot(`data:${p.mime};base64,${p.base64}`); } },
  };
}
