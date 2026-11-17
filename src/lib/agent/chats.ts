// Agent chats: local only (Dexie `chats`), never synced, never in backups. Written straight to the table —
// not through db.save(), which would queue them for sync.
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uuid } from '../../db/db';
import type { AgentContext, Chat } from './types';

export const QUICK_TTL = 3 * 86400000; // quick chats are deleted after 3 days unless kept
export const QUICK_REUSE = 15 * 60000; // a new quick entry within 15 min for the same purpose continues the chat

export const getChat = (id: string) => db.chats.get(id);
export async function putChat(chat: Chat): Promise<Chat> {
  const next = { ...chat, updatedAt: Date.now() };
  await db.chats.put(next);
  return next;
}
export async function newChat(context?: AgentContext, quickKey?: string): Promise<Chat> {
  const now = Date.now();
  const chat: Chat = { id: uuid(), title: 'New chat', messages: [], pending: null, cards: {}, context, createdAt: now, updatedAt: now,
    ...(quickKey ? { kind: 'quick' as const, quickKey } : {}) };
  await db.chats.put(chat);
  return chat;
}
/** Change only these fields (never a whole-record put: the loop, the title helper and the UI write concurrently). */
export const patchChat = (id: string, patch: Partial<Chat>) => db.chats.update(id, { ...patch, updatedAt: Date.now() });
/** Same, without bumping updatedAt (UI settings like the model pick shouldn't reorder the list). */
export const setChatFields = (id: string, patch: Partial<Chat>) => db.chats.update(id, patch);
export const deleteChat = (id: string) => db.chats.delete(id);
export const setChatContext = (id: string, context: AgentContext) => setChatFields(id, { context });
export async function renameChat(id: string, title: string) {
  if (title.trim()) await setChatFields(id, { title: title.trim().slice(0, 80), renamed: true });
}
/** Keep a quick chat: it becomes a normal chat (shown in the list, never auto-deleted). */
export const keepChat = (id: string) => setChatFields(id, { kind: 'normal' });
/** The quick chat to continue for this purpose, if one was active in the last 15 minutes. */
export async function recentQuickChat(quickKey: string) {
  const since = Date.now() - QUICK_REUSE;
  return (await db.chats.where('updatedAt').above(since).toArray()).find((c) => c.kind === 'quick' && c.quickKey === quickKey);
}
/** Delete quick chats untouched for 3 days, and empty chats older than a day. Runs on app start. */
export async function purgeChats() {
  const now = Date.now();
  const old = await db.chats.filter((c) => (c.kind === 'quick' && now - c.updatedAt > QUICK_TTL) || (!c.messages.length && now - c.updatedAt > 86400000)).primaryKeys();
  if (old.length) await db.chats.bulkDelete(old);
}

export const useChats = () => useLiveQuery(() => db.chats.orderBy('updatedAt').reverse().toArray(), []);
export const useChat = (id: string | undefined) => useLiveQuery(() => (id ? db.chats.get(id) : undefined), [id]);
