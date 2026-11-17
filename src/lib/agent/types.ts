// Neutral agent types (docs/agent-contract.md, incl. "# v2 changes"). Mirrored in server/src/ai/types.ts — keep in sync.

export type AIPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; base64: string }
  | { type: 'file'; mime: string; name: string; base64: string } // PDF ≤ 10 MB
  | { type: 'video'; mime: string; base64: string }; // ≤ 20 MB, only for providers with video:true
export type AIToolCall = { id: string; name: string; args: Record<string, unknown> };
export type AIMessage =
  | { role: 'user'; content: AIPart[] }
  | { role: 'assistant'; text?: string; toolCalls?: AIToolCall[]; opaque?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export type AITool = { name: string; description: string; parameters: Record<string, unknown> };
export type Effort = 'low' | 'medium' | 'high';
export type ProviderId = 'chatgpt' | 'openrouter';

/** Per user: which provider first when both are connected. */
export type AIConfig = { primary: ProviderId; fallback: ProviderId | null };
/** Admin-only global settings (apply to everyone). */
export type AIGlobal = {
  models: { chatgpt: string; openrouter: string };
  openrouterProvider: { order: string[]; allow_fallbacks: boolean } | null;
  defaultEffort: Effort;
  helperEffort: Effort;
  webModel: string;
};
export type AIProviderInfo = { id: ProviderId; connected: boolean; model: string; label: string; video: boolean; files: boolean };
export type AIStatus = {
  isAdmin: boolean;
  global: AIGlobal;
  config: AIConfig;
  chatgpt: { connected: boolean; email?: string };
  openrouter: { hasKey: boolean };
  providers: AIProviderInfo[];
};
export type AIModel = { id: string; name: string };

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: AIToolCall }
  | { type: 'done'; provider: string; model: string; effort?: Effort; opaque?: unknown; usage?: { input: number; output: number } }
  | { type: 'error'; code: 'no_provider' | 'auth' | 'limit' | 'provider' | 'bad_request' | 'network'; message: string };

export type TurnRequest = { instructions: string; messages: AIMessage[]; tools: AITool[]; effort?: Effort; provider?: ProviderId };

export type RequestAction = {
  name: string;
  input: Record<string, unknown>;
  /** food requests: alternative food keys (entries.log: string[]; entries.logMany: one list per item) */
  alternatives?: string[] | string[][];
  /** food requests: items the user unchecked on the card (by item index) */
  off?: boolean[];
};
export type PendingStatus = 'pending' | 'applying';
export type AskQuestion = { id: string; question: string; options: string[]; multi?: boolean; other?: boolean };
/** A card waiting for the user. kind 'request' (default, also for old chats) = request_changes; 'ask' = ask_user.
 *  `applying` = Apply was tapped; if the app died mid-apply we never re-run it. */
export type PendingRequest = {
  kind?: 'request' | 'ask';
  toolCallId: string;
  summary: string;
  actions: RequestAction[];
  questions?: AskQuestion[];
  status: PendingStatus;
};

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
  /** titled by the helper call already */
  titled?: boolean;
  /** this chat's model pick (header chip); undefined = the user's preferred provider / global default effort */
  provider?: ProviderId;
  effort?: Effort;
  /** what actually ran last (from `done`) */
  ran?: { provider: string; model: string; effort?: Effort };
  messages: AIMessage[];
  pending?: PendingRequest | null;
  /** past cards by toolCallId, so the chat can still render them after they were answered */
  cards?: Record<string, { summary: string; actions: RequestAction[]; outcome: 'applied' | 'rejected' | 'comment' | 'failed' | 'answered'; comment?: string;
    kind?: 'request' | 'ask'; questions?: AskQuestion[]; answers?: Record<string, string | string[]> }>;
  context?: AgentContext;
  /** last error shown under the chat (cleared on the next send) */
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}
