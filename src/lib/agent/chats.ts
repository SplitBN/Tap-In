// Agent chats (Dexie `chats`). Written straight to the table, not through db.save(): chats keep their own
// timestamps (updatedAt orders the list and is not bumped by UI-only changes) and are synced as a stripped copy.
//
// Backup (Settings → Agent → Back up chats, default on): every write bumps `syncAt` and queues an outbox entry, and
// lib/sync.ts pushes syncCopy(chat) — photos / files / videos become placeholders (the local copy keeps them), long
// tool results are cut, and the record is kept under the server's 64 KB limit. Deleting leaves a tombstone
// (deletedAt, contents emptied) so the deletion reaches other devices; tombstones are hidden everywhere here.
import { useLiveQuery } from 'dexie-react-hooks';
import { changed, db, uuid } from '../../db/db';
import type { AIMessage, AIPart, AgentContext, Chat } from './types';

export const QUICK_TTL = 3 * 86400000; // quick chats are deleted after 3 days unless kept
export const QUICK_REUSE = 15 * 60000; // a new quick entry within 15 min for the same purpose continues the chat
const TOMBSTONE_TTL = 30 * 86400000; // local tombstones are dropped after 30 days (the server keeps its own)

const live = (c: Chat | undefined): c is Chat => !!c && !c.deletedAt;

// ---------------- backup queue ----------------
export async function chatBackupOn() {
  const s = await db.settings.get('settings');
  return s?.agent?.backupChats !== false;
}
/** Queue chats for the next sync (no-op when backup is off). */
async function queue(...ids: string[]) {
  if (!ids.length || !(await chatBackupOn())) return;
  const at = Date.now();
  await db.outbox.bulkAdd(ids.map((recordId) => ({ table: 'chats', recordId, at })));
  changed();
}
/** Backup switched (back) on, or a fresh account link: upload every chat, tombstones included. */
export async function queueAllChats() {
  await queue(...((await db.chats.toCollection().primaryKeys()) as string[]));
}

// ---------------- reads (tombstones hidden) ----------------
export const getChat = async (id: string) => { const c = await db.chats.get(id); return live(c) ? c : undefined; };
export const useChats = () => useLiveQuery(async () => (await db.chats.orderBy('updatedAt').reverse().toArray()).filter(live), []);
/** undefined while loading and when the chat doesn't exist (or was deleted: a tombstone). */
export const useChat = (id: string | undefined) => useLiveQuery(async () => { if (!id) return undefined; const c = await db.chats.get(id); return live(c) ? c : undefined; }, [id]);
/** The quick chat to continue for this purpose, if one was active in the last 15 minutes. */
export async function recentQuickChat(quickKey: string) {
  const since = Date.now() - QUICK_REUSE;
  return (await db.chats.where('updatedAt').above(since).toArray()).find((c) => live(c) && c.kind === 'quick' && c.quickKey === quickKey);
}

// ---------------- writes ----------------
export async function putChat(chat: Chat): Promise<Chat> {
  const now = Date.now();
  if ((await db.chats.get(chat.id))?.deletedAt) return chat; // deleted meanwhile: don't resurrect it
  const next = { ...chat, updatedAt: now, syncAt: now };
  await db.chats.put(next);
  await queue(next.id);
  return next;
}
export async function newChat(context?: AgentContext, quickKey?: string): Promise<Chat> {
  const now = Date.now();
  const chat: Chat = { id: uuid(), title: 'New chat', messages: [], pending: null, cards: {}, context, createdAt: now, updatedAt: now, syncAt: now,
    ...(quickKey ? { kind: 'quick' as const, quickKey } : {}) };
  await db.chats.put(chat);
  await queue(chat.id);
  return chat;
}
/** The row, unless it is a tombstone: a turn or title call that finishes after the chat was deleted must not write
 *  its content back into the deleted record. */
const liveRow = (id: string) => db.chats.where(':id').equals(id).filter((c) => !c.deletedAt);
/** Change only these fields (never a whole-record put: the loop, the title helper and the UI write concurrently). */
export async function patchChat(id: string, patch: Partial<Chat>) {
  const now = Date.now();
  const n = await liveRow(id).modify({ ...patch, updatedAt: now, syncAt: now });
  if (n) await queue(id);
  return n;
}
/** Same, without bumping updatedAt (UI settings like the model pick shouldn't reorder the list). */
export async function setChatFields(id: string, patch: Partial<Chat>) {
  const n = await liveRow(id).modify({ ...patch, syncAt: Date.now() });
  if (n) await queue(id);
  return n;
}
const tombstone = (c: Chat, now: number): Chat => ({ id: c.id, title: '', messages: [], pending: null, cards: {}, createdAt: c.createdAt, updatedAt: c.updatedAt, syncAt: now, deletedAt: now });
export async function deleteChat(id: string) {
  const c = await db.chats.get(id);
  if (!live(c)) return;
  await db.chats.put(tombstone(c, Date.now()));
  await queue(id);
}
export const setChatContext = (id: string, context: AgentContext) => setChatFields(id, { context });
export async function renameChat(id: string, title: string) {
  if (title.trim()) await setChatFields(id, { title: title.trim().slice(0, 80), renamed: true });
}
/** Keep a quick chat: it becomes a normal chat (shown in the list, never auto-deleted). */
export const keepChat = (id: string) => setChatFields(id, { kind: 'normal' });
/** Delete quick chats untouched for 3 days, and empty chats older than a day (as tombstones, so it syncs); drop old
 *  local tombstones. Runs on app start. */
export async function purgeChats() {
  const now = Date.now();
  const all = await db.chats.toArray();
  const old = all.filter((c) => live(c) && ((c.kind === 'quick' && now - c.updatedAt > QUICK_TTL) || (!c.messages.length && now - c.updatedAt > 86400000)));
  if (old.length) { await db.chats.bulkPut(old.map((c) => tombstone(c, now))); await queue(...old.map((c) => c.id)); }
  const gone = all.filter((c) => c.deletedAt && now - c.deletedAt > TOMBSTONE_TTL).map((c) => c.id);
  if (gone.length) await db.chats.bulkDelete(gone);
}

// ---------------- the synced copy ----------------
const MAX_SYNC_CHARS = 60_000; // server limit: JSON.stringify(record).length ≤ 64 KiB; keep a margin
export const PLACEHOLDER = { image: '[photo]', video: '[video]' } as const;
const TRUNC_MARK = '[truncated]';
const DROPPED = '<context>[earlier messages are only on the device they were sent from]</context>';

function placeholder(p: AIPart): AIPart {
  if (p.type === 'image') return { type: 'text', text: PLACEHOLDER.image };
  if (p.type === 'video') return { type: 'text', text: PLACEHOLDER.video };
  if (p.type === 'file') return { type: 'text', text: `[file "${p.name}"]` };
  return p;
}
const isPlaceholder = (p: AIPart) => p.type === 'text' && (p.text === PLACEHOLDER.image || p.text === PLACEHOLDER.video || /^\[file ".*"\]$/.test(p.text));
/** Shorten a tool result and keep it valid JSON (the UI parses request_changes results for status / comment). */
function cutTool(content: string, max: number) {
  if (content.length <= max) return content;
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const keep = Object.fromEntries(['status', 'comment', 'error', 'note'].filter((k) => typeof o[k] === 'string').map((k) => [k, String(o[k]).slice(0, 500)]));
      return JSON.stringify({ truncated: true, ...keep, preview: content.slice(0, Math.max(0, max - 200)) });
    }
  } catch { /* not JSON */ }
  return `${content.slice(0, max)} ${TRUNC_MARK}`;
}
const cutText = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)} ${TRUNC_MARK}` : t);
const isCut = (content: string) => content.startsWith('{"truncated":true') || content.endsWith(TRUNC_MARK);

function shrinkMessages(msgs: AIMessage[], toolMax: number, textMax: number): AIMessage[] {
  return msgs.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content.map((p) => { const q = placeholder(p); return q.type === 'text' ? { type: 'text', text: cutText(q.text, textMax) } : q; }) };
    if (m.role === 'assistant') { const { opaque: _o, ...rest } = m; return { ...rest, ...(rest.text ? { text: cutText(rest.text, textMax) } : {}) }; }
    return { ...m, content: cutTool(m.content, toolMax) };
  });
}

/** What goes to the server: no attachment payloads, no provider-private `opaque`, long tool output cut, and always
 *  under the record size limit (as a last resort the oldest turns are dropped, never splitting a tool call from its
 *  result). The local record is untouched. */
const isDropped = (m: AIMessage | undefined) => m?.role === 'user' && m.content[0]?.type === 'text' && m.content[0].text === DROPPED;
export function syncCopy(chat: Chat): Chat {
  if (chat.deletedAt) return tombstone(chat, chat.deletedAt);
  const size = (c: Chat) => JSON.stringify(c).length;
  const steps: [number, number][] = [[4000, 20000], [1000, 6000], [300, 2000]];
  let out: Chat = chat;
  for (const [toolMax, textMax] of steps) {
    out = { ...chat, messages: shrinkMessages(chat.messages, toolMax, textMax) };
    if (size(out) <= MAX_SYNC_CHARS) return out;
  }
  out = { ...out, displays: {} }; // charts/tables are re-drawable; drop them before dropping turns
  // drop the oldest turns: cut at a user message so every remaining tool result still has its call
  let msgs = out.messages;
  while (size({ ...out, messages: msgs }) > MAX_SYNC_CHARS && msgs.length > 1) {
    const first = isDropped(msgs[0]) ? 1 : 0; // the first real message, kept until the next user turn is found
    const next = msgs.findIndex((m, i) => i > first && m.role === 'user');
    if (next <= 0) break; // one turn left that is still too big: the last resort below
    msgs = [{ role: 'user', content: [{ type: 'text', text: DROPPED }] }, ...msgs.slice(next)];
  }
  const ids = new Set(msgs.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])));
  const cards = Object.fromEntries(Object.entries(out.cards ?? {}).filter(([k]) => ids.has(k)));
  out = { ...out, messages: msgs, cards };
  if (size(out) > MAX_SYNC_CHARS) out = { ...out, messages: [{ role: 'user', content: [{ type: 'text', text: DROPPED }] }], cards: {}, pending: null };
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Identity of a message that survives syncCopy's cutting (for lining a pulled copy up with the local one). */
const sig = (m: AIMessage) => (m.role === 'tool' ? `t:${m.toolCallId}` : m.role === 'assistant' ? `a:${(m.toolCalls ?? []).map((c) => c.id).join(',')}:${(m.text ?? '').slice(0, 200)}`
  : `u:${m.content.map((p) => { const q = placeholder(p); return q.type === 'text' ? q.text.slice(0, 200) : ''; }).join('|')}`);
/** A chat pulled from the server, merged with this device's copy: placeholders, cut tool results and opaque state
 *  come back from the local record wherever the messages line up, so a sync never deletes local photos. */
export function hydrateChat(incoming: Chat, local: Chat | undefined): Chat {
  if (!local || incoming.deletedAt || local.deletedAt) return incoming;
  let msgs = incoming.messages;
  if (isDropped(msgs[0])) {
    const j = msgs.length > 1 ? local.messages.findIndex((m) => sig(m) === sig(msgs[1])) : -1;
    if (j < 0) return incoming;
    msgs = [...local.messages.slice(0, j), ...msgs.slice(1)];
  }
  const merged = msgs.map((m, i) => {
    const l = local.messages[i];
    if (!l || l.role !== m.role) return m;
    if (m.role === 'user' && l.role === 'user') {
      if (m.content.length !== l.content.length) return m;
      const lp = l.content;
      return { ...m, content: m.content.map((p, k) => ((isPlaceholder(p) && lp[k].type !== 'text') || (p.type === 'text' && p.text.endsWith(TRUNC_MARK) && lp[k].type === 'text') ? lp[k] : p)) };
    }
    if (m.role === 'assistant' && l.role === 'assistant') {
      if (!same(m.toolCalls, l.toolCalls)) return m;
      return { ...m, ...(m.opaque === undefined && l.opaque !== undefined ? { opaque: l.opaque } : {}), ...(m.text?.endsWith(TRUNC_MARK) ? { text: l.text } : {}) };
    }
    if (m.role === 'tool' && l.role === 'tool') return l.toolCallId === m.toolCallId && isCut(m.content) ? l : m;
    return m;
  });
  return { ...incoming, messages: merged, displays: { ...local.displays, ...incoming.displays } };
}
