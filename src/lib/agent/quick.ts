// Quick chats open as a sheet over the current page (QuickChatHost in pages/Agent.tsx). Any screen can start one.
import { useSyncExternalStore } from 'react';
import { startQuickChat } from './loop';
import type { AIPart, AgentContext } from './types';

let quickId: string | null = null;
const subs = new Set<() => void>();
export const setQuickChat = (id: string | null) => { quickId = id; subs.forEach((f) => f()); };
export const useQuickChat = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => quickId);

/** Start (or continue, within 15 min for the same purpose) a quick chat and show it in a sheet. */
export async function openQuickChat(parts: AIPart[], context: AgentContext, quickKey: string) {
  setQuickChat(await startQuickChat(parts, context, quickKey));
}
