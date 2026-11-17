// The agent loop runs on the client (docs/agent-contract.md): one /ai/turn per step, tools executed here, the chat
// persisted after every step. It stops when the model answers without tool calls, when a request card is waiting for
// the user, or after MAX_STEPS steps for one user message. Acting on the card appends its tool result and continues.
import { useSyncExternalStore } from 'react';
import { getSettings } from '../../db/settings';
import { getStatus, isFake, turn } from './client';
import { getChat, newChat, putChat, recentQuickChat } from './chats';
import { buildInstructions, contextBlock } from './instructions';
import { applyActions, cap, executeTool, toolList, type ToolEnv } from './tools';
import type { AIMessage, AIPart, AIToolCall, AgentContext, Chat } from './types';

export const MAX_STEPS = 12;

// ---- live (in-memory) state per chat: running + the text streaming in right now ----
type Live = { running: boolean; text: string };
const IDLE: Live = { running: false, text: '' };
const live = new Map<string, Live>();
const aborts = new Map<string, AbortController>();
const subs = new Set<() => void>();
const setLive = (id: string, p: Partial<Live>) => { live.set(id, { ...(live.get(id) ?? IDLE), ...p }); subs.forEach((f) => f()); };
export const useLive = (id: string | undefined) => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => (id ? live.get(id) ?? IDLE : IDLE));
export const isRunning = (id: string) => !!live.get(id)?.running;

// ---- environment (prefs + whether web_answer is possible), status cached for a minute ----
let statusCache: { at: number; hasOpenRouter: boolean } | null = null;
async function toolEnv(): Promise<ToolEnv> {
  const s = await getSettings();
  if (!statusCache || Date.now() - statusCache.at > 60_000) {
    try { statusCache = { at: Date.now(), hasOpenRouter: (await getStatus()).openrouter.hasKey }; }
    catch { statusCache = { at: Date.now(), hasOpenRouter: isFake() }; }
  }
  return { ask: s.agent?.ask !== false, web: s.agent?.web !== false, hasOpenRouter: statusCache.hasOpenRouter };
}
export const invalidateAgentStatus = () => { statusCache = null; };

const stepsSinceUser = (m: AIMessage[]) => {
  let n = 0;
  for (let i = m.length - 1; i >= 0 && m[i].role !== 'user'; i--) if (m[i].role === 'assistant') n++;
  return n;
};
const titleFrom = (parts: AIPart[]) => {
  const t = parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 40 ? t.slice(0, 39) + '…' : t) : 'Photo';
};

/** Does the chat need the loop to continue (last message is the user's or a tool result, nothing pending)? */
export function needsReply(c: Chat) {
  const last = c.messages[c.messages.length - 1];
  return !c.pending && !!last && last.role !== 'assistant';
}

/** Send a user message. While a request card is waiting, the text answers it as a comment. */
export async function sendMessage(chatId: string, parts: AIPart[], context?: AgentContext) {
  let c = await getChat(chatId);
  if (!c || isRunning(chatId)) return;
  const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim();
  const ctx = context ?? c.context;
  // the volatile context rides on the message, not in the instructions (keeps the cached prompt prefix stable)
  const withContext = (p: AIPart[]): AIPart[] => [{ type: 'text', text: contextBlock(ctx) }, ...p];
  if (c.pending?.status === 'pending' && text) {
    await resolvePending(chatId, { type: 'comment', comment: text }, false);
    c = (await getChat(chatId))!;
    const images = parts.filter((p) => p.type === 'image');
    if (images.length) c = await putChat({ ...c, messages: [...c.messages, { role: 'user', content: withContext(images) }] });
    return runLoop(chatId);
  }
  if (c.pending) return;
  const first = !c.messages.some((m) => m.role === 'user');
  await putChat({ ...c, error: null, context: ctx, title: first && !c.renamed ? titleFrom(parts) : c.title, messages: [...c.messages, { role: 'user', content: withContext(parts) }] });
  return runLoop(chatId);
}

/** Quick entry (e.g. a food photo from Add food): continue the quick chat for the same purpose if it was active in
 *  the last 15 minutes, else start one. Returns the chat id at once; the reply streams in the background. */
export async function startQuickChat(parts: AIPart[], context: AgentContext, quickKey: string): Promise<string> {
  let prev = await recentQuickChat(quickKey);
  if (prev && isRunning(prev.id)) prev = undefined; // busy: start a fresh one rather than drop the photo
  const id = prev?.id ?? (await newChat(context, quickKey)).id;
  if (prev?.pending?.status === 'pending') await resolvePending(id, { type: 'comment', comment: 'Never mind that, see my next message.' }, false);
  void sendMessage(id, parts, context);
  return id;
}

export type Decision = { type: 'apply' } | { type: 'reject'; comment?: string } | { type: 'comment'; comment: string };

/** The user acted on the request card: append the tool result, then continue the loop. */
const resolving = new Set<string>(); // synchronous guard: a double-tap on Apply must not apply twice
export async function resolvePending(chatId: string, d: Decision, continueLoop = true) {
  if (resolving.has(chatId)) return;
  resolving.add(chatId);
  try { await resolveOnce(chatId, d); } finally { resolving.delete(chatId); }
  if (continueLoop) await runLoop(chatId);
}
async function resolveOnce(chatId: string, d: Decision) {
  let c = await getChat(chatId);
  const p = c?.pending;
  if (!c || !p || p.status !== 'pending') return;
  let content: string;
  let outcome: 'applied' | 'rejected' | 'comment' | 'failed';
  if (d.type === 'apply') {
    c = await putChat({ ...c, pending: { ...p, status: 'applying' } }); // never re-run if the app dies mid-apply
    const { results, failed } = await applyActions(p.actions);
    content = cap({ status: 'applied', results, ...(failed ? { note: 'An action failed; actions after it were skipped. Earlier ones were applied.' } : {}) });
    outcome = failed ? 'failed' : 'applied';
  } else if (d.type === 'reject') {
    content = cap({ status: 'rejected', ...(d.comment?.trim() ? { comment: d.comment.trim() } : {}) });
    outcome = 'rejected';
  } else {
    content = cap({ status: 'comment', comment: d.comment.trim() });
    outcome = 'comment';
  }
  const comment = d.type !== 'apply' ? d.comment?.trim() || undefined : undefined;
  await putChat({ ...c, error: null, pending: null, cards: { ...c.cards, [p.toolCallId]: { summary: p.summary, actions: p.actions, outcome, comment } },
    messages: [...c.messages, { role: 'tool', toolCallId: p.toolCallId, name: 'request_changes', content }] });
}

/** On open: a card left in "applying" (the app died mid-apply) is closed as failed instead of re-running it. */
export async function recoverChat(chatId: string) {
  const c = await getChat(chatId);
  const p = c?.pending;
  if (!c || !p || p.status !== 'applying' || isRunning(chatId)) return;
  await putChat({ ...c, pending: null, cards: { ...c.cards, [p.toolCallId]: { summary: p.summary, actions: p.actions, outcome: 'failed' } },
    messages: [...c.messages, { role: 'tool', toolCallId: p.toolCallId, name: 'request_changes',
      content: cap({ status: 'interrupted', note: 'The app closed while applying. Some actions may have been applied; check with run_query before proposing again.' }) }] });
}

export function stop(chatId: string) { aborts.get(chatId)?.abort(); }

/** Run model steps until done. Safe to call again: a running chat is left alone. */
export async function runLoop(chatId: string) {
  if (isRunning(chatId)) return;
  const ac = new AbortController();
  aborts.set(chatId, ac);
  setLive(chatId, { running: true, text: '' });
  try {
    const env = await toolEnv();
    const tools = toolList(env);
    for (;;) {
      let c = await getChat(chatId);
      if (!c || !needsReply(c) || ac.signal.aborted) break;
      if (stepsSinceUser(c.messages) >= MAX_STEPS) {
        await putChat({ ...c, messages: [...c.messages, { role: 'assistant', text: `I stopped after ${MAX_STEPS} steps. Say “go on” if you want me to continue.` }] });
        break;
      }
      const instructions = await buildInstructions();
      let text = '', opaque: unknown, error: string | null = null;
      const calls: AIToolCall[] = [];
      for await (const ev of turn({ instructions, messages: c.messages, tools, tier: 'smart' }, ac.signal)) {
        if (ev.type === 'text') { text += ev.delta; setLive(chatId, { text }); }
        else if (ev.type === 'tool_call') calls.push(ev.call);
        else if (ev.type === 'done') opaque = ev.opaque;
        else if (ev.type === 'error') error = errorText(ev.code, ev.message);
      }
      c = (await getChat(chatId))!;
      if (ac.signal.aborted) {
        if (text) await putChat({ ...c, messages: [...c.messages, { role: 'assistant', text }] });
        break;
      }
      if (error) { await putChat({ ...c, error }); break; }

      const msg: AIMessage = { role: 'assistant', ...(text ? { text } : {}), ...(calls.length ? { toolCalls: calls } : {}), ...(opaque !== undefined ? { opaque } : {}) };
      const messages: AIMessage[] = [...c.messages, msg];
      let pending = c.pending ?? null;
      const cards = { ...c.cards };
      for (const call of calls) {
        if (call.name === 'request_changes' && pending) {
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: cap({ error: 'Only one request per reply. Wait for the result of the first one.' }) });
          continue;
        }
        const out = await executeTool(call, env);
        if ('pending' in out && out.pending) { pending = out.pending; continue; }
        if ('applied' in out) cards[call.id] = { summary: out.applied.summary, actions: out.applied.actions, outcome: out.applied.failed ? 'failed' : 'applied' };
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.content! });
      }
      setLive(chatId, { text: '' });
      await putChat({ ...c, messages, pending, cards }); // one write per step
      if (!calls.length || pending) break;
    }
  } catch (e) {
    const c = await getChat(chatId);
    if (c) await putChat({ ...c, error: (e as Error).message || 'Something went wrong' });
  } finally {
    aborts.delete(chatId);
    setLive(chatId, { running: false, text: '' });
  }
}

function errorText(code: string, message: string) {
  switch (code) {
    case 'no_provider': return 'No AI account connected. Settings → Agent: connect ChatGPT or add an OpenRouter key.';
    case 'auth': return message.includes('Sign in') ? message : 'The AI account needs reconnecting: Settings → Agent.';
    case 'limit': return 'Usage limit reached. Try again later or switch provider in Settings → Agent.';
    default: return message || 'The assistant failed. Try again.';
  }
}
