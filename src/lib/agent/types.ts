// Neutral agent types (docs/agent-contract.md). Mirrored in server/src/ai/types.ts — keep in sync.

export type AIPart = { type: 'text'; text: string } | { type: 'image'; mime: string; base64: string };
export type AIToolCall = { id: string; name: string; args: Record<string, unknown> };
export type AIMessage =
  | { role: 'user'; content: AIPart[] }
  | { role: 'assistant'; text?: string; toolCalls?: AIToolCall[]; opaque?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export type AITool = { name: string; description: string; parameters: Record<string, unknown> };
export type Tier = 'smart' | 'cheap';
export type ProviderId = 'chatgpt' | 'openrouter';

export type AIConfig = {
  primary: ProviderId;
  fallback: ProviderId | null;
  models: { chatgpt: { smart: string | null; cheap: string | null }; openrouter: { smart: string; cheap: string } };
  webModel: string;
};
export type AIStatus = { chatgpt: { connected: boolean; email?: string }; openrouter: { hasKey: boolean }; config: AIConfig };
export type AIModel = { id: string; name: string };

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: AIToolCall }
  | { type: 'done'; provider: string; model: string; opaque?: unknown; usage?: { input: number; output: number } }
  | { type: 'error'; code: 'no_provider' | 'auth' | 'limit' | 'provider' | 'bad_request' | 'network'; message: string };

export type TurnRequest = { instructions: string; messages: AIMessage[]; tools: AITool[]; tier: Tier };

export type RequestAction = { name: string; input: Record<string, unknown> };
export type PendingStatus = 'pending' | 'applying';
/** A request card waiting for the user. `applying` = Apply was tapped; if the app died mid-apply we never re-run it. */
export type PendingRequest = { toolCallId: string; summary: string; actions: RequestAction[]; status: PendingStatus };

/** Where the user opened the agent from (route + date shown in that screen). */
export type AgentContext = { route: string; date?: string };

/** Local only (Dexie `chats`), never synced. */
export interface Chat {
  id: string;
  title: string;
  /** quick = started from a quick entry point (e.g. photo in Add food): opens as a sheet, hidden from the main list,
   *  auto-deleted after 3 days unless kept (Keep turns it into a normal chat). undefined = normal. */
  kind?: 'normal' | 'quick';
  /** quick chats: what they are for (e.g. "food:lunch:2026-11-17"), so a new photo within 15 min continues the chat */
  quickKey?: string;
  /** the user renamed it: never auto-titled */
  renamed?: boolean;
  messages: AIMessage[];
  pending?: PendingRequest | null;
  /** past request cards by toolCallId, so the chat can still render them after they were answered */
  cards?: Record<string, { summary: string; actions: RequestAction[]; outcome: 'applied' | 'rejected' | 'comment' | 'failed'; comment?: string }>;
  context?: AgentContext;
  /** last error shown under the chat (cleared on the next send) */
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}
