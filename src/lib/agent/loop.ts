// The agent loop runs on the client (docs/agent-contract.md): one /ai/turn per step, tools executed here, the chat
// persisted after every step. It stops when the model answers without tool calls, when a card (request or question) is
// waiting for the user, or after MAX_STEPS steps for one user message. Acting on the card appends its result and continues.
// Writes are field patches (patchChat), never whole-record puts: the title helper and the UI write to the same chat.
import { useSyncExternalStore } from 'react';
import { getSettings } from '../../db/settings';
import { getStatus, isFake, turn } from './client';
import { getChat, newChat, patchChat, recentQuickChat } from './chats';
import { buildInstructions, contextBlock, isContextPart, TITLE_INSTRUCTIONS } from './instructions';
import { applyActions, appliedSummary, cap, executeTool, isBlocking, isParallelSafe, toolList, type ToolEnv, type ToolOutcome } from './tools';
import type { AIMessage, AIPart, AIStatus, AIToolCall, AgentContext, Chat, Effort, RequestAction } from './types';

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

// ---- status (cached for a minute): providers, global defaults, web ----
let statusCache: { at: number; status: AIStatus | null } | null = null;
export async function cachedStatus(): Promise<AIStatus | null> {
  if (!statusCache || Date.now() - statusCache.at > 60_000) {
    try { statusCache = { at: Date.now(), status: await getStatus() }; } catch { statusCache = { at: Date.now(), status: null }; }
  }
  return statusCache.status;
}
export const invalidateAgentStatus = () => { statusCache = null; };
async function toolEnv(): Promise<ToolEnv> {
  const s = await getSettings();
  const st = await cachedStatus();
  return { web: s.agent?.web !== false, hasOpenRouter: st ? st.openrouter.hasKey : isFake(), permissions: s.agent?.permissions ?? {} };
}

const stepsSinceUser = (m: AIMessage[]) => {
  let n = 0;
  for (let i = m.length - 1; i >= 0 && m[i].role !== 'user'; i--) if (m[i].role === 'assistant') n++;
  return n;
};
const userText = (parts: AIPart[]) => parts.map((p) => (p.type === 'text' && !isContextPart(p.text) ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim();
const titleFrom = (parts: AIPart[]) => {
  const t = userText(parts);
  if (t) return t.length > 40 ? t.slice(0, 39) + '…' : t;
  return parts.some((p) => p.type === 'image') ? 'Photo' : parts.some((p) => p.type === 'video') ? 'Video' : 'File';
};

/** Does the chat need the loop to continue (last message is the user's or a tool result, nothing pending)? */
export function needsReply(c: Chat) {
  const last = c.messages[c.messages.length - 1];
  return !c.pending && !!last && last.role !== 'assistant';
}

/** Send a user message. While a card is waiting, the text answers it (a comment on a request, free text for a question). */
export async function sendMessage(chatId: string, parts: AIPart[], context?: AgentContext) {
  let c = await getChat(chatId);
  if (!c || isRunning(chatId)) return;
  const text = userText(parts);
  const ctx = context ?? c.context;
  // the volatile context rides on the message, not in the instructions (keeps the cached prompt prefix stable)
  const withContext = (p: AIPart[]): AIPart[] => [{ type: 'text', text: contextBlock(ctx) }, ...p];
  if (c.pending?.status === 'pending' && text) {
    await resolvePending(chatId, c.pending.kind === 'ask' ? { type: 'answer', answers: {}, text } : { type: 'comment', comment: text }, false);
    c = (await getChat(chatId))!;
    const media = parts.filter((p) => p.type !== 'text');
    if (media.length) await patchChat(chatId, { messages: [...c.messages, { role: 'user', content: withContext(media) }] });
    return runLoop(chatId);
  }
  if (c.pending) return;
  const first = !c.messages.some((m) => m.role === 'user');
  await patchChat(chatId, { error: null, context: ctx, ...(first && !c.renamed ? { title: titleFrom(parts) } : {}), messages: [...c.messages, { role: 'user', content: withContext(parts) }] });
  return runLoop(chatId);
}

/** Quick entry (e.g. a food photo from Add food): continue the quick chat for the same purpose if it was active in
 *  the last 15 minutes, else start one. Returns the chat id at once; the reply streams in the background. */
export async function startQuickChat(parts: AIPart[], context: AgentContext, quickKey: string): Promise<string> {
  let prev = await recentQuickChat(quickKey);
  if (prev && isRunning(prev.id)) prev = undefined; // busy: start a fresh one rather than drop the photo
  const id = prev?.id ?? (await newChat(context, quickKey)).id;
  if (prev?.pending?.status === 'pending') await resolvePending(id, prev.pending.kind === 'ask' ? { type: 'answer', answers: {}, text: 'Never mind, see my next message.' } : { type: 'comment', comment: 'Never mind that, see my next message.' }, false);
  void sendMessage(id, parts, context);
  return id;
}

export type Decision =
  | { type: 'apply' } | { type: 'reject'; comment?: string } | { type: 'comment'; comment: string }
  | { type: 'answer'; answers: Record<string, string | string[]>; text?: string };

/** The user acted on the card: append the tool result, then continue the loop. */
const resolving = new Set<string>(); // synchronous guard: a double-tap on Apply must not apply twice
export async function resolvePending(chatId: string, d: Decision, continueLoop = true) {
  if (resolving.has(chatId)) return;
  resolving.add(chatId);
  try { await resolveOnce(chatId, d); } finally { resolving.delete(chatId); }
  if (continueLoop) await runLoop(chatId);
}
async function resolveOnce(chatId: string, d: Decision) {
  const c = await getChat(chatId);
  const p = c?.pending;
  if (!c || !p || p.status !== 'pending') return;
  const kind = p.kind ?? 'request';
  const name = kind === 'ask' ? 'ask_user' : 'request_changes';
  let content: string;
  let card: NonNullable<Chat['cards']>[string];
  if (kind === 'ask') {
    const answers = d.type === 'answer' ? d.answers : {};
    const text = d.type === 'answer' ? d.text?.trim() : d.type === 'comment' ? d.comment.trim() : undefined;
    content = cap({ answers, ...(text ? { text } : {}) });
    card = { kind: 'ask', summary: p.summary, actions: [], questions: p.questions, answers, outcome: 'answered', ...(text ? { comment: text } : {}) };
  } else if (d.type === 'apply') {
    await patchChat(chatId, { pending: { ...p, status: 'applying' } }); // never re-run if the app dies mid-apply
    const { results, failed, applied } = await applyActions(p.actions);
    content = cap({ status: 'applied', results, applied: appliedSummary(applied), ...(failed ? { note: 'An action failed; actions after it were skipped. Earlier ones were applied.' } : {}) });
    card = { summary: p.summary, actions: p.actions, outcome: failed ? 'failed' : 'applied' };
  } else if (d.type === 'reject') {
    content = cap({ status: 'rejected', ...(d.comment?.trim() ? { comment: d.comment.trim() } : {}) });
    card = { summary: p.summary, actions: p.actions, outcome: 'rejected', comment: d.comment?.trim() || undefined };
  } else {
    const comment = d.type === 'comment' ? d.comment.trim() : d.text?.trim() ?? '';
    content = cap({ status: 'comment', comment });
    card = { summary: p.summary, actions: p.actions, outcome: 'comment', comment };
  }
  const now = (await getChat(chatId))!;
  await patchChat(chatId, { error: null, pending: null, cards: { ...now.cards, [p.toolCallId]: card },
    messages: [...now.messages, { role: 'tool', toolCallId: p.toolCallId, name, content }] });
}

/** Edit the waiting request in place (food card swaps / amounts / unchecks), so reload and Apply see the same thing. */
export async function updatePendingActions(chatId: string, actions: RequestAction[]) {
  const c = await getChat(chatId);
  if (!c?.pending || c.pending.status !== 'pending') return;
  await patchChat(chatId, { pending: { ...c.pending, actions } });
}

/** On open: a card left in "applying" (the app died mid-apply) is closed as failed instead of re-running it. */
export async function recoverChat(chatId: string) {
  const c = await getChat(chatId);
  const p = c?.pending;
  if (!c || !p || p.status !== 'applying' || isRunning(chatId)) return;
  await patchChat(chatId, { pending: null, cards: { ...c.cards, [p.toolCallId]: { summary: p.summary, actions: p.actions, outcome: 'failed' } },
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
        await patchChat(chatId, { messages: [...c.messages, { role: 'assistant', text: `I stopped after ${MAX_STEPS} steps. Say “go on” if you want me to continue.` }] });
        break;
      }
      const instructions = await buildInstructions();
      let text = '', opaque: unknown, error: string | null = null, ran: Chat['ran'];
      const calls: AIToolCall[] = [];
      for await (const ev of turn({ instructions, messages: c.messages, tools, ...(c.effort ? { effort: c.effort } : {}), ...(c.provider ? { provider: c.provider } : {}) }, ac.signal)) {
        if (ev.type === 'text') { text += ev.delta; setLive(chatId, { text }); }
        else if (ev.type === 'tool_call') calls.push(ev.call);
        else if (ev.type === 'done') { opaque = ev.opaque; ran = { provider: ev.provider, model: ev.model, ...(ev.effort ? { effort: ev.effort } : {}) }; }
        else if (ev.type === 'error') error = errorText(ev.code, ev.message);
      }
      c = (await getChat(chatId))!;
      if (ac.signal.aborted) {
        if (text) await patchChat(chatId, { messages: [...c.messages, { role: 'assistant', text }] });
        break;
      }
      if (error) { await patchChat(chatId, { error }); break; }

      const msg: AIMessage = { role: 'assistant', ...(text ? { text } : {}), ...(calls.length ? { toolCalls: calls } : {}), ...(opaque !== undefined ? { opaque } : {}) };
      // one blocking card per step: the first request_changes / ask_user in call order wins
      const blocker = calls.find((x) => isBlocking(x.name));
      const outs = new Map<string, ToolOutcome>();
      await Promise.all(calls.filter((x) => isParallelSafe(x.name)).map(async (x) => { outs.set(x.id, await executeTool(x, env)); }));
      for (const x of calls) {
        if (outs.has(x.id)) continue;
        if (isBlocking(x.name) && x !== blocker) { outs.set(x.id, { content: cap({ error: 'Only one card per reply (request_changes or ask_user). Wait for the result of the first one.' }) }); continue; }
        outs.set(x.id, await executeTool(x, env)); // writes run one at a time, in order
      }
      const messages: AIMessage[] = [...c.messages, msg];
      let pending = c.pending ?? null;
      const cards = { ...c.cards };
      for (const x of calls) { // results in call order
        const out = outs.get(x.id)!;
        if ('pending' in out && out.pending) { pending = out.pending; continue; }
        if ('applied' in out) cards[x.id] = { summary: out.applied.summary, actions: out.applied.actions, outcome: out.applied.failed ? 'failed' : 'applied' };
        messages.push({ role: 'tool', toolCallId: x.id, name: x.name, content: out.content! });
      }
      setLive(chatId, { text: '' });
      await patchChat(chatId, { messages, pending, cards, ...(ran ? { ran } : {}) }); // one write per step
      if (!calls.length || pending) break;
    }
  } catch (e) {
    await patchChat(chatId, { error: (e as Error).message || 'Something went wrong' });
  } finally {
    aborts.delete(chatId);
    setLive(chatId, { running: false, text: '' });
  }
  void maybeTitle(chatId);
}

/** After the first assistant reply: one helper call (no tools, helper effort) for a 2–5 word title. Never part of the chat. */
async function maybeTitle(chatId: string) {
  const c = await getChat(chatId);
  if (!c || c.renamed || c.titled || !c.messages.some((m) => m.role === 'assistant')) return;
  await patchChat(chatId, { titled: true }); // once, even if it fails
  const firstUser = c.messages.find((m) => m.role === 'user') as Extract<AIMessage, { role: 'user' }> | undefined;
  const firstReply = c.messages.find((m) => m.role === 'assistant' && m.text) as Extract<AIMessage, { role: 'assistant' }> | undefined;
  const said = firstUser ? userText(firstUser.content) : '';
  const media = firstUser?.content.some((p) => p.type !== 'text') ? ' (with an attachment)' : '';
  const convo = `User${media}: ${said || '(attachment only)'}\nAssistant: ${(firstReply?.text ?? '').slice(0, 400)}`;
  const st = await cachedStatus();
  const effort: Effort = st?.global.helperEffort ?? 'low';
  let title = '';
  try {
    for await (const ev of turn({ instructions: TITLE_INSTRUCTIONS, messages: [{ role: 'user', content: [{ type: 'text', text: convo }] }], tools: [], effort, ...(c.provider ? { provider: c.provider } : {}) })) {
      if (ev.type === 'text') title += ev.delta;
      if (ev.type === 'error') return;
    }
  } catch { return; }
  title = title.replace(/^["'“”\s]+|["'“”.!\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 60);
  const now = await getChat(chatId);
  if (title && now && !now.renamed) await patchChat(chatId, { title });
}

function errorText(code: string, message: string) {
  switch (code) {
    case 'no_provider': return 'No AI account connected. Settings → Agent: connect ChatGPT or add an OpenRouter key.';
    case 'auth': return message.includes('Sign in') ? message : 'The AI account needs reconnecting: Settings → Agent.';
    case 'limit': return 'Usage limit reached. Try again later or switch provider in Settings → Agent.';
    default: return message || 'The assistant failed. Try again.';
  }
}
