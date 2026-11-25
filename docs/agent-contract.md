# Agent contract (v1)

The in-app AI agent. Server = Cloudflare Worker (`server/`), client = the PWA (`src/`). This file is the contract both
sides build against. Keep it updated when either side changes.

## Principles
- App code never talks to a provider. The client talks to `/ai/*` on our Worker; the Worker picks the provider.
- The agent loop runs **on the client**: commands live in the client (Dexie, local-first), so tool calls execute there.
  The Worker only does one model step per request (`/ai/turn`) plus the web tools.
- Writes are gated **by the harness using `Command.kind`**, never by trusting the model.
- Credentials (ChatGPT tokens, OpenRouter keys) live only on the server, encrypted (AES-GCM, key = wrangler secret
  `AI_ENC_KEY`), per user. Never in a synced table, never in the page, never logged.
- Each user (owner and friends) brings their own credential: Connect ChatGPT and/or an OpenRouter key.

## Neutral message format (shared TS types — `src/lib/agent/types.ts`, mirrored in `server/src/ai/types.ts`)
```ts
type AIPart = { type: 'text'; text: string } | { type: 'image'; mime: string; base64: string }; // images downscaled ≤1024px jpeg on client
type AIToolCall = { id: string; name: string; args: Record<string, unknown> };
type AIMessage =
  | { role: 'user'; content: AIPart[] }
  | { role: 'assistant'; text?: string; toolCalls?: AIToolCall[]; opaque?: unknown } // opaque: provider-private items (e.g. reasoning) the server needs back next turn; client stores and returns verbatim
  | { role: 'tool'; toolCallId: string; name: string; content: string };          // content = JSON string, capped at 12k chars by the client
type AITool = { name: string; description: string; parameters: Record<string, unknown> }; // JSON Schema object
type Tier = 'smart' | 'cheap';
```

## Worker routes (all need the normal bearer auth)
| Route | Body → Response |
|---|---|
| `GET /ai/status` | → `{ chatgpt: { connected: boolean, email?: string }, openrouter: { hasKey: boolean }, config: AIConfig }` |
| `POST /ai/config` | `Partial<AIConfig>` → `{ config }` |
| `POST /ai/openrouter/key` | `{ key: string \| null }` → `{ hasKey }` (server validates the key with a cheap OpenRouter call `GET /api/v1/key` before saving) |
| `POST /ai/chatgpt/start` | → `{ url }` authorize URL (PKCE + state stored ~10 min) |
| `POST /ai/chatgpt/finish` | `{ pastedUrl }` → `{ connected: true, email? }` or 400 with a plain message |
| `POST /ai/chatgpt/disconnect` | → `{ ok, revoked }` (revokes, deletes tokens; `revoked:false` = remote revocation not confirmed — tell the user they can disconnect the app in ChatGPT Settings) |
| `GET /ai/models?provider=chatgpt\|openrouter` | → `{ models: { id, name }[] }` (chatgpt: 409 `{code:'not_connected'}` when not connected; openrouter: public list of all models, no key needed) |
| `POST /ai/turn` | `{ instructions, messages: AIMessage[], tools: AITool[], tier: Tier }` → **SSE** (`text/event-stream`), events below |
| `POST /ai/web/answer` | `{ query }` → `{ answer, citations: string[] }` (OpenRouter, model `config.webModel`, default `perplexity/sonar`; 409 `{code:'no_key'}` without an OpenRouter key) |
| `POST /ai/web/read` | `{ url, prompt?: string \| null }` → `{ mode: 'raw' \| 'extract' \| 'full', content, tokens, title? }` (`tokens` = estimated size of the whole page text, not of `content`) |

JSON route errors are `{ error: string, code?: string }`. Provider failures on JSON routes are never 401 (401 means "sign in to
Tap In"): `limit` → 429, `bad_request` → 400, `auth` / `provider` → 502, each with `code`.

```ts
type AIConfig = {
  primary: 'chatgpt' | 'openrouter';
  fallback: 'chatgpt' | 'openrouter' | null;
  models: { chatgpt: { smart: string | null; cheap: string | null }; openrouter: { smart: string; cheap: string } }; // null = first listed model
  webModel: string; // OpenRouter model for web_answer
};
```

### `/ai/turn` SSE events (one JSON object per `data:` line; `: …` comment lines are keep-alives — ignore them)
After bearer auth `/ai/turn` always answers 200 SSE; every failure (bad body, no provider, provider error) is an `error` event.
```ts
{ type: 'text', delta: string }
{ type: 'tool_call', call: AIToolCall }            // complete call (server buffers argument deltas)
{ type: 'done', provider: string, model: string, opaque?: unknown, usage?: { input: number; output: number } }
{ type: 'error', code: 'no_provider' | 'auth' | 'limit' | 'provider' | 'bad_request', message: string }
```
Fallback: if the primary fails **before any event was sent** with auth / 429 / 5xx, the server retries on `fallback`.
`opaque` is only valid for the same provider; the server drops opaque items that came from a different provider.

### web/read rules
http(s) only; reject localhost, IP literals in private/loopback/link-local ranges, and non-standard ports; 10 s timeout;
read at most 2 MB; HTML → readable text (strip script/style/nav/footer, keep headings/lists/links as text).
tokens ≈ chars/4. If tokens ≤ 1000 → `raw` (whole page, even if a prompt was given). Else if prompt → `extract`
(a separate cheap-tier call on the user's provider: "Answer the question using only this page… say if it isn't there",
page capped at ~60k tokens). Else → `full`, capped at 12k tokens with a `[truncated]` marker.
If extract can't run (no usable provider, or it fails) the server degrades to `full`. Non-text content (PDF, images) → 415.
Redirects are followed manually (max 5), each hop re-checked; URLs with credentials are rejected.

## Provider adapters (server)
- `chatgpt` — SIWC tokens. `POST https://api.openai.com/v1/responses`, `store:false`, `stream:true`,
  `include:['reasoning.encrypted_content']`, system prompt via `instructions`, no temperature/top_p/max_output_tokens/
  previous_response_id/system-role items. Function tools as top-level `{type:'function', name, description, parameters}`
  (if the API rejects that, try supplying them via namespaces as the SIWC preview-limitations page describes).
  Reasoning items returned → `opaque`, sent back in `input` next turn. Tokens: access 1 h, refresh 30 d rotating; refresh
  serialized in a per-user Durable Object (`AiAuth`, migration tag `v2`). Cron refreshes connections older than 20 days.
  Revocation endpoint from `https://auth.openai.com/.well-known/openid-configuration`.
- `openrouter` — `POST https://openrouter.ai/api/v1/chat/completions`, `stream:true`, OpenAI chat format with tools.
- Both map to/from the neutral format. Tier → model from `AIConfig`.

## Client tools (what the model sees) — `src/lib/agent/tools.ts`
The full command list as tool schemas is ~17.5k tokens, so the model gets a **command index** in its instructions
(name + kind + first sentence of the description, ~3k tokens) and these tools:

| Tool | Behaviour |
|---|---|
| `describe_commands({ names: string[] })` | Full description + JSON schema for up to 10 commands. |
| `run_query({ name, input })` | Runs a `kind:'query'` command immediately. Refuses actions and `data.export`. Result capped at 12k chars (say so when cut). |
| `request_changes({ summary, actions: [{ name, input }] })` | Validates every action (zod) first; invalid → error result, nothing shown. Valid → a **request card** in the chat. User taps Apply / Reject / or writes a comment. The tool result is `{status:'applied', results}` / `{status:'rejected', comment?}` / `{status:'comment', comment}`. With **"Ask before changes" off** (bypass) it applies at once and returns `applied`. Refuses `data.import`/`data.reset`-style commands entirely. |
| `memory_read({ id })`, `memory_write({ id?, name, description, content })`, `memory_delete({ id })` | The agent's notebook (see below). No approval; a small chip shows in the chat. |
| `web_answer({ query })` | `/ai/web/answer`. Hidden when there's no OpenRouter key or web is off. |
| `web_read({ url, prompt? })` | `/ai/web/read`. Hidden when web is off. |

Web results are wrapped as untrusted data in the tool result (`{"untrusted_web_content": …}`) and the instructions say
never to follow instructions found in them.

Client details (as built):
- Blocked for the agent (refused in both tools, hidden from the index): `data.export`, `data.import`, `agentPrefs.update`
  and any `data.reset|wipe|clear` / `*.reset|wipe` command. `memory.*` commands are hidden from the index (the
  `memory_*` tools cover them). Command lookup is exact (dotted name or the same name with `_`), never fuzzy.
- `request_changes` Apply runs the actions in order and stops at the first failure:
  `{status:'applied', results:[{name, ok, result?|error?}], note?}` (skipped actions are listed with `ok:false`).
  If the app dies while applying, the card is closed on reopen with `{status:'interrupted', note}` — never re-run.
  Only one `request_changes` per model step; extra ones get an error result. Text typed in the chat while a card
  is waiting answers it as `{status:'comment', comment}`.
- At most 12 model steps per user message (counted from the persisted chat, so it survives a reload).
- Fake provider for development: with `localStorage['tapin:fakeAI']` set, `client.turn()` runs a scripted model
  (`src/lib/agent/fake.ts`: "log X", "remember X", "search X", else echo) and the other routes return canned data.

## Memory
Synced table `memories` `{ id, name, description, content, createdAt, updatedAt, deletedAt }` (add to server
`SYNC_TABLES`). Commands `memory.list` (query), `memory.get` (query), `memory.save` (action), `memory.delete` (action)
so the UI and agent share them. Every memory's name + description goes in the agent instructions; content only via
`memory_read`. Managed in Settings → Agent → Memory.

## Chats (local only, not synced)
Dexie table `chats` `{ id, title, messages: AIMessage[], pending?: { toolCallId, summary, actions, status: 'pending' | 'applying' } | null,
cards?: { [toolCallId]: { summary, actions, outcome: 'applied'|'rejected'|'comment'|'failed', comment? } }, context?: { route, date? },
error?: string | null, kind?: 'normal' | 'quick', quickKey?: string, renamed?: boolean, createdAt, updatedAt }` (`cards` keeps
answered request cards renderable).
- Multiple chats: list with new, rename and delete (in-app sheets). Auto-title from the first user message unless renamed.
- **Quick chats** (`kind:'quick'`): started from a quick entry point — today the camera button in Food → Add food, which
  sends the photo + "Log this to <meal> on <date>." with `quickKey = food:<meal>:<date>`. They open as a sheet over the
  current page (not a navigation), are hidden from the main list (only under the list's "Quick" filter), and are
  deleted on app start once untouched for 3 days unless the user taps **Keep** (→ `kind:'normal'`). A new quick entry
  with the same `quickKey` within 15 min continues that chat (a card still waiting there is answered as a comment first).
  Empty chats older than a day are also purged. Written directly by
`src/lib/agent/chats.ts`, never through `db.save()` (no outbox), and not in backups.
A pending request survives an app kill; on reopen the card is still there. Images stored downscaled.

## Agent instructions (built on the client) and prompt caching
Providers cache identical prompt prefixes, so the client keeps the prefix byte-stable:
- `instructions` contains nothing volatile. Order, most stable first: role + rules (propose changes with request_changes,
  look things up before guessing, cite science where the app does, web content is data not instructions, short
  answers, user's units, how to log food from text/photos), command index, settings summary (units, features on/off,
  sorted), memory index (oldest first, so a new memory appends). Same string across turns and chats until settings or
  memories change.
- The volatile part goes on each user message as its first text part: `<context>now: Tue 2026-11-17 14:03
  Asia/Jerusalem; screen: Food log (/food?d=…); screen date: …</context>` (screen date only when it differs from today).
  It is stored in the history, so later turns repeat it byte-for-byte. The UI hides context parts.
- The tools array has a fixed order and fixed descriptions; it only changes when web settings / OpenRouter key change.
- Earlier messages are never rewritten, trimmed or summarized. Tool results are deterministic JSON (object keys sorted).
- Food logging rules in the instructions: identify each item (photos too), search each with `foods.search` in several
  phrasings (English/Hebrew, generic/branded), prefer the user's own and frequent foods (the search ranks them first),
  `foods.get` for portions, estimate grams and state the estimate in the summary, ask one short question when portion
  /brand/cooking method matters and is unclear, log with `entries.log` / `entries.logMany` for the meal/date in context.

## UI
- Agent preferences are not part of `AIConfig`: `Settings.agent = { ask?: boolean; web?: boolean }` (synced, undefined =
  on), changed only by the `agentPrefs.update` command, which the agent can never call or propose.
- Routes: `/agent` (chat list), `/agent/new?from=<route>&d=<date>` (reuses the newest empty chat or starts one with that
  context), `/agent/:id` (chat; the tab bar hides there). The floating button sits bottom-left (the Food + is bottom-right).
- Feature toggle `features.agent` (Settings). When on: an **Agent** route `/agent` (chat list + chat), reachable from a
  Home widget, and a **floating button** on every screen except `/agent` and `/session/*` (clear of the rest timer),
  opening `/agent` with the current route as context.
- Chat: bubbles, streaming text, tool activity chips ("Looked up foods", "Read memory"), request cards (each action as a
  readable row rendered from the actual validated input, ids resolved to names where cheap: food, exercise,
  supplement, workout), Apply / Reject / comment field, photo attach (camera/library), new chat, chat history.
- Settings → Agent: Connect ChatGPT (paste-the-URL flow with clear steps), OpenRouter key, primary/backup, models
  (picker from `/ai/models`), web search on/off, web model, "Ask before changes" toggle (warn: with it off, a web page
  could trick the agent into changes), Memory list (view/edit/delete).

---

# v2 changes (2026-11-17, from the user's first real use) — these override v1 where they differ

## Models, effort, admin
- **No smart/cheap models.** One model per provider; "smart" = higher **reasoning effort**. `/ai/turn` takes
  `effort?: 'low' | 'medium' | 'high'` (accept old `tier` as alias: cheap→low, smart→high). ChatGPT: `reasoning: { effort }`.
  OpenRouter: `reasoning: { effort }`.
- **Global config, admin only** (D1 `ai_global`, one row). Admin = user ids in secret `ADMIN_USER_IDS` (comma list; already set).
  ```ts
  type AIGlobal = {
    models: { chatgpt: string; openrouter: string };          // defaults: 'gpt-6.1-sol' (if not in the account's list → first listed), 'z-ai/glm-5.3-flash'
    openrouterProvider: { order: string[]; allow_fallbacks: boolean } | null; // default { order: ['river'], allow_fallbacks: true } → sent as OpenRouter `provider`
    defaultEffort: 'low' | 'medium' | 'high';                 // default 'medium'
    helperEffort: 'low' | 'medium' | 'high';                  // titles, web/read extract — default 'low'
    webModel: string;                                         // default 'perplexity/sonar'
  };
  ```
  `POST /ai/global` (admin only, 403 otherwise) `Partial<AIGlobal>` → `{ global }`.
- **Per user** only: preferred provider when both are connected (`primary`, `fallback`). Old per-user `models` ignored.
- `GET /ai/status` → `{ isAdmin, global, config: { primary, fallback }, chatgpt: { connected, email? }, openrouter: { hasKey },
  providers: { id: 'chatgpt'|'openrouter', connected: boolean, model: string, label: string, video: boolean, files: boolean }[] }`
  (label e.g. "GPT-6.1 Sol" / "GLM 5.3 Flash"; video true for openrouter GLM 5.3 Flash, false for chatgpt).
- `/ai/turn` body adds optional `provider` (the chat's pick; used first, then the user's fallback) and `effort`.
  `done` carries `provider`, `model`, `effort`.
- `GET /ai/models` stays (admin uses it for pickers).

## Attachments
`AIPart` adds:
```ts
| { type: 'file'; mime: string; name: string; base64: string }   // PDF (≤ 10 MB). ChatGPT: input_file {filename, file_data:'data:…'}; OpenRouter: {type:'file', file:{filename, file_data}}
| { type: 'video'; mime: string; base64: string }                // ≤ 20 MB, only when the provider has video:true. OpenRouter: {type:'video_url', video_url:{url:'data:…'}}
```
Client: text/CSV/JSON/MD files are inlined as text parts (capped ~30k chars, say so). Video on a provider without video →
client extracts ~6 frames (canvas) and sends them as images with a note. Images still ≤1024 px JPEG.

## Client tools (changes)
- **Batch:** `run_query` takes `{ queries: [{ name, input }] }` (1–8, run in parallel, results in order). The loop also runs
  several tool calls from one step in parallel. Instructions: batch independent lookups in one step.
- **Commands in the prompt:** full description + schema for a curated core set (the commands the agent uses most: food
  search/get/log/logMany/list, goals, sessions/plans/exercise search & history, bodyweight, supplements day/log, calendar),
  budget ≈ 6k tokens, the rest as the one-line index; `describe_commands` only for those. Order fixed (cache).
- **`ask_user({ questions: [{ id, question, options: string[], multi?: boolean, other?: boolean }] })`**: one card with all
  questions as tappable chips (+ optional free text when `other`), one Send. Result `{ answers: { [id]: string | string[] } }`.
  Pending like a request card (survives reload). Text typed in the composer while it's open answers it as free text.
- **Food requests:** an action `entries.log` / `entries.logMany` item may carry `alternatives?: string[]` (food keys).
  The card can swap the food (keeping grams) and change the amount before Apply; the applied input is what the user saw.
- **Photo logging instructions:** work out as much as possible from the image (items, cooking method, portion from visual
  cues: plate/hand/utensil size, count pieces), search candidates in one batched step, prefer the user's own/frequent foods,
  ask only what truly changes the numbers and **all in one `ask_user`**, then one food request with alternatives. Never
  drip questions over several turns.
- **Chat titles:** after the first assistant reply, one helper call (helperEffort, no tools) → 2–5 word title (unless renamed).

## Permissions (replaces the single "Ask before changes")
`Settings.agent.permissions: Record<Category, 'ask' | 'auto'>`, all default `ask`. Categories from command name prefix:
- `food` (foods, entries, recipes, goals, maintenance), `gym` (plans, workouts, sessions, sets, exercises),
  `supplements` (supplements, stacks, supplogs), `body` (bodyweight, notes, days), `settings` (settings, features).
A request mixing categories auto-applies only if every action's category is `auto`. Managed in a **Permissions** sheet
(Settings → Agent → Permissions), one row per category with an Ask / Auto segmented control, and a one-line warning that Auto
lets a web page the agent read trigger changes. Still only changeable by the user (`agentPrefs.update`), never the agent.

## UI changes
- **Chat**: friendlier, bubblier "liquid" look (glass header, soft gradient bubbles, rounded 22–26px, springy appear
  animations, typing indicator), consistent with the rest of the app and `docs/design-refs`. **Header is sticky** (title,
  back, ⋯ always visible). **Composer is pinned to the bottom** respecting the safe area exactly like the tab-bar fix
  (`--app-h` / `env(safe-area-inset-bottom)`), not floating high. Header shows a **model chip** ("Sol · Medium") → sheet to
  pick provider (only connected ones) and effort (Low / Medium / High) for this chat (stored on the chat).
- **Food request card** in the style of the user's reference: "Total Calories — 830 cals / 46 g Protein" header; one rounded
  row per food: emoji (by food name keywords), name, macros `117C 10P 1F` in role colours, right side calories + amount in
  the food's unit when it has portions ("2.2 cups", "3 drumsticks") in blue (tap → number picker), a green check to
  include/exclude, alternatives as horizontal chips below the row; bottom: secondary "Change" (focuses composer for a
  comment) + primary green "Log (N)". Other request kinds get the same friendly row style (icon, title, short detail).
- **ask_user card**: question text + chip options, Send.
- **Memory** gets its own page (`/agent/memory`), linked from Settings → Agent; not stacked in Settings.
- **Settings → Agent** for everyone: Connect ChatGPT, OpenRouter key, preferred provider (when both), Permissions, Memory,
  web on/off. **Admin only**: "For everyone" section — model per provider (pickers from /ai/models), OpenRouter provider
  routing, default effort, helper effort, web model.
- Attach menu in the composer: Photo, Camera, Video, File.

## v2 server notes (implementation details / small deviations)
- `/ai/turn`: `effort` falls back to old `tier` (cheap→low, smart→high), then to `global.defaultEffort`. Unknown `provider`
  or effort values → `bad_request`. `done.effort` = the effort actually used.
- Part validation: `file` must be `application/pdf`, base64 ≤ 10 MB decoded; `video` must be `video/*`, ≤ 20 MB decoded.
- ChatGPT + `video` part → `bad_request` "ChatGPT can't watch videos…", but marked fallback-eligible, so if the user's
  backup provider (e.g. OpenRouter GLM) is connected it takes the turn instead.
- ChatGPT: if the model rejects `reasoning` (400 mentioning reasoning/effort) the server retries once without it.
- ChatGPT model: `global.models.chatgpt` if the account's `/v1/models` list (visibility=list, cached 6 h) has it, else
  the first listed model. If the list can't be loaded, the configured id is tried as is.
- OpenRouter: `reasoning: { effort }` always sent; `provider` = `global.openrouterProvider` when not null (an empty `order`
  in `POST /ai/global` sets it to null = OpenRouter's own routing). Reasoning output isn't replayed (no `opaque`).
- `providers[].files` is true for both (OpenRouter parses PDFs for any model). `video` for OpenRouter comes from the
  model's `architecture.input_modalities` in OpenRouter's public model list; `label` = that list's name without the
  "Vendor: " prefix, or for ChatGPT the account list's `display_name`; else a prettified id ("GPT-6.1 Sol").
- `GET /ai/models?provider=openrouter` items also carry `input: string[]` (input modalities) for the admin picker.
- `POST /ai/config` only accepts `primary` / `fallback`; any stored v1 `models` / `webModel` are ignored.

## v2 client notes (as built)
- Permission categories by prefix: food = foods, entries, recipes, goals, maintenance; gym = plans, workouts, sessions,
  sets, exercises, **items**; supplements = supplements, stacks, supplogs; body = bodyweight, notes, days; settings =
  settings, features. Any other prefix (e.g. `records.restore`) always asks. The v1 `Settings.agent.ask` is ignored.
- Core commands in the prompt (fixed order, ≈5.9k tokens measured as chars/4): foods.search/get, entries.list/log/logMany/
  update/delete/quickAdd/copy/move/deleteMany, foods.create, goals.get/set, days.setComplete, stats.dailyNutrition,
  sessions.list/get/active/summary, plans.list, exercises.search/history/nextTarget, progress.exercise, bodyweight.list/log,
  supplements.day/log/list, notes.add/list, calendar.range (`CORE` in src/lib/agent/tools.ts). Index ≈1.9k tokens.
- `run_query` still accepts the v1 `{ name, input }` (old chats). In a batch each query gets an equal share of the 12k cap.
  Read-only tools in one step run in parallel; writes and cards run in call order; results are appended in call order.
  One card per step: the first `request_changes` / `ask_user` wins, the others get an error result.
- Food requests: when validated, `alternatives` are moved out of the input into `RequestAction.alternatives` (unknown keys
  dropped) and every item gets explicit `grams` + `qty` + `unit`. Card edits (swap keeps grams, amount, uncheck →
  `RequestAction.off[]`) are written to the stored pending request. Apply drops unchecked items and the tool result is
  `{status:'applied', results, applied:[{name,input}]}`, where `applied` holds the inputs as they were run.
- `ask_user` result: `{ answers: {[id]: string | string[]}, text? }`. `text` is what was typed in the composer instead.
- Chat fields added: `provider?`, `effort?` (the model chip; sent as `/ai/turn` `provider` / `effort`; omitted = the
  user's preferred provider / global default effort), `ran?` (from `done`), `titled?`. Chat writes are field patches
  (`db.chats.update`), never whole-record puts.
- Title: after the loop's first assistant reply, one `/ai/turn` with `TITLE_INSTRUCTIONS`, no tools, `effort =
  global.helperEffort`. Never added to the chat.
- Keyboard: `lib/viewport.ts` sets `--kb` from `visualViewport` (and `html.kb-open`); the chat screen sits on `bottom: var(--kb)`.
- Fake provider (v2): admin status with both providers (GLM has video), photo + "log this…" → ask_user → batched
  run_query → food request with alternatives; "log X" → batched search → food request; title calls answered.

---

# v3 changes (2026-11-18, second round of real use) — override earlier sections where they differ

## Effort: admin only, "auto" by default
- Users never see effort. The chat model sheet only offers **which provider** (ChatGPT plan / OpenRouter), and only when
  both are connected; with one connected the chip just shows the model name (no sheet).
- `Effort = 'auto' | 'low' | 'medium' | 'high'`. `auto` = send no reasoning/effort parameter (provider/model default).
- `AIGlobal`: `defaultEffort` (default `'auto'`), `titleEffort` (default `'low'`), `extractEffort` (default `'auto'`);
  `helperEffort` removed (read it as a fallback for old rows). Admin section shows all three with Auto/Low/Medium/High.
- `/ai/turn` `effort` stays accepted (admin testing) but the client no longer sends it except for the title call
  (`effort: 'title'` alias → server uses `titleEffort`). Server ignores a non-admin's explicit effort other than `'title'`.

## Request card comments (bug fix)
Bug: commenting on a pending request hid the comment, closed the card as "changed", the agent replied, and nothing was
actionable anymore. New behaviour:
- The comment is shown as a normal user bubble in the chat.
- The card stays **open** (Apply / Reject still work) after a comment. Tool result:
  `{status:'comment', comment, note:'The request is still open and the user can still apply it as is. If it should change, call request_changes again with the full revised version — that replaces this card.'}`
- A new request_changes in the same chat **supersedes** the older open card (old one shows "Replaced", greyed).
- Applying or rejecting a card whose tool call was already answered (commented) appends a short user-side note
  (`<context>user applied the earlier request: …results…</context>` / rejected) and continues the loop so the agent knows.
- Same for ask_user: typed text answers it; the card shows the answer.

## Chats housekeeping
- Chat list: **Select** mode (checkboxes, Select all, Delete N with an in-app confirm).
- Chats not updated for 7 days move to a collapsed **Older** row at the bottom ("Older · 23"), expanded on tap; quick
  chats keep their 3-day purge. Search field at the top of the list when there are > 10 chats.

## Keyboard (bug fix)
On iPhone the composer moves up but still sits partly under the keyboard. Compute the keyboard inset from
`visualViewport` correctly: `kb = max(0, window.innerHeight - vv.height - vv.offsetTop)` measured against the layout
viewport the app actually uses (`--app-h`), and drop the bottom safe-area padding while the keyboard is open (the
keyboard already covers the home indicator). Re-measure on `vv.resize` and `vv.scroll`. Keep the last message visible.

## Rich answers: charts, tables, stat tiles
New display tools (client-only, no side effects, no approval):
- `show_chart({ title, kind: 'line'|'bar'|'area'|'scatter', y_label?, unit?, series: Series[], markers?: Marker[], bands?: Band[], journal?: boolean })`
  - `Series = { name, points?: {x: string /*YYYY-MM-DD or label*/, y: number}[], source?: { command: string, input: object, x: string, y: string, path?: string } }`
    — either inline points or a **source**: a `kind:'query'` command the client runs itself (so big data never goes through
    the model), with dotted field paths into the result rows (`path` = where the row array is, e.g. `"days"`).
  - `Marker = { x, label }` (single events, e.g. "PR"), `Band = { from, to?, label, tone?: 'good'|'bad'|'neutral' }`
    (ranges, e.g. creatine on/off, a cut).
  - `journal: true` overlays the user's journal entries in the chart's date range automatically (points as markers,
    ranges as bands).
- `show_table({ title?, columns: string[], rows: (string|number|null)[][] })` (≤ 50 rows; scrolls horizontally).
- `show_stats({ items: { label, value, unit?, delta?: number, good?: 'up'|'down' }[] })` — big friendly tiles.
Rendered inline in the chat with the app's chart components (`src/components/Charts.tsx`), role colours, dark theme,
tap a point for its value. The tool result is a tiny ack (`{shown:true, points:n}`) so the model can comment on it.
Instructions: prefer a chart/tiles/table over listing numbers; keep the text short around them; for "bench over time"
use the exercise progress query as source; for supplement effects add creatine-on/off bands from supplement history.

## Journal (new)
Dated life events that can't be inferred from logs ("Started cut", "Exam season", "Moved out", "Sick").
- Synced table `journal` `{ id, date, endDate?: string|null, title, note?: string, tag?: 'diet'|'training'|'health'|'life'|'other', createdAt, updatedAt, deletedAt }`
  (add to server SYNC_TABLES and backup).
- Commands: `journal.list` (query; from/to filter), `journal.add`, `journal.update`, `journal.end` (set endDate), `journal.delete` (actions).
  Permission category `journal` (default ask).
- UI: Journal page (`/journal`) — timeline list grouped by month, ongoing items marked, + to add (title, date, optional end,
  tag, note); reachable from Home (widget or link) and Calendar (journal items show on their days); toggle `features.journal`.
- Charts overlay journal entries (see `journal: true`); the agent may propose journal entries when the user mentions such
  events ("I started a cut today" → propose journal.add) and uses them when explaining trends.

## Memory: always-on + notebook
- Memory stays the agent's notebook (preferences, facts about the user), separate from the journal (dated events).
- `Memory` adds `pinned: boolean`. **Pinned** memories' full content goes in the instructions (cap ~1.5k tokens total;
  the agent is told to keep pinned ones short, e.g. "bad left shoulder, avoid overhead pressing"); the rest stay as an
  index (name + description) read with memory_read. memory_write takes `pinned`. Memory page shows a pin toggle.

## v3 server notes
- `/ai/turn` effort resolution: `'title'` → `global.titleEffort` (anyone); an explicit level (or old `tier` alias) is
  honoured only for admins; otherwise `global.defaultEffort`. `'auto'` sends no `reasoning` field to either provider.
  `done.effort` reports the resolved value (may be `'auto'`).
- Old stored `helperEffort` seeds both `titleEffort` and `extractEffort`; explicit new fields win. `POST /ai/global`
  still accepts `helperEffort` (sets both) but the response/status never include it.
- `journal` added to server `SYNC_TABLES`.

## v3 client notes (as built)
- Effort: the client sends no `effort` on normal turns and `effort: 'title'` on the title call. The chat chip only names
  the model; with both providers connected it opens a "Use" sheet (ChatGPT plan / OpenRouter). Admin section has
  Thinking / Chat titles / Page extracts, each Auto · Low · Med · High. A v2 `helperEffort` is read as both helpers.
- Card comments: the comment is the tool result (`status:'comment'` + note) and renders as the user's bubble right
  after the card; the pending card stays open with `answered: true` (it no longer blocks the loop or new messages).
  Apply/Reject on an answered card appends a user message `<context>user applied|rejected the earlier request "…": …</context>`
  (rendered as a small centred note) and continues the loop. A new card replaces an open one (`outcome: 'replaced'`).
- Display tools resolve on the client into `chat.displays[toolCallId]` (local only). Sources must be non-blocked
  `kind:'query'` commands; x values that are timestamps become dates; > 365 points are evenly downsampled (ends kept).
  Journal overlay: entries with an end or ongoing → bands (ongoing runs to the chart end), single days → markers.
  The tool result is `{shown, points, series:[{name, points, first, last}], bands, markers}` or `{error}`.
- Journal: `endDate` undefined = single day, `null` = ongoing, date = range; `journal.add` takes `ongoing`;
  `journal.update` takes `singleDay` to drop the end. Dexie v5 table `journal`, in sync TABLES and backups,
  `features.journal`, permission category `journal`. UI: /journal, Home widget, Calendar (underlined days + day sheet + legend).
- Memory: `memory.pin` command; pinned contents inline in the instructions up to ~6k chars (the rest fall back to the
  index); memory page has a pin toggle per row.
- Keyboard: `keyboardInset(vv, frameH = --app-h, innerH)` = `frameH − (vv.offsetTop + vv.height)`, counted only when it
  exceeds the closed-state gap (frameH − innerH) by 80 px; sets `--kb`, `--kb-top` (= offsetTop while open) and
  `html.kb-open` (drops the composer's safe-area padding). The chat screen spans `top: var(--kb-top)` to
  `bottom: var(--kb)`; the scroller re-pins to the last message on `visualViewport` resize.
- Chats: Select mode (select all / delete N with confirm), "Older" fold for chats untouched 7 days, search when > 10.

# Science first (2026-11-24) — evidence library + academic web search

- `src/data/evidence.json`: ~76 curated findings (meta-analyses, position stands, key RCTs). Each: id, topic, tags,
  question, finding (numbers), certainty, evidenceType, population, practical, citations (authors, year, title,
  journal, doi?, pmid?, url). Citation fields are copied from PubMed esummary / Crossref, never typed by hand.
- `evidence.search { query, k?=3, topic? }` (core command): BM25F over tags/question/topic/finding/practical with a
  small synonym map; returns compact hits (finding, practical, certainty, type, refs {cite, url}). `evidence.get { id }`
  returns the full entry. The JSON loads lazily (own chunk).
- `web_answer { query, academic? }` → `/ai/web/answer { query, academic? }`. Academic mode prefixes the user message
  with a peer-reviewed-only instruction (works for any `webModel`) and adds `search_mode: 'academic'` +
  `web_search_options.search_context_size: 'high'` best-effort; on a 400 it retries without the extras.
- Instructions: "Science first" section (evidence hierarchy, evidence.search before advice, academic web for gaps,
  plain-word certainty/effect size, user data as an n-of-1 experiment with noise/confounder checks).

---

# v4 voice calls (2026-11-24) — adds to earlier sections

A call is a normal chat driven by voice (`Chat.voice = true` marks that a call happened); the transcript is the usual
message history. Client: `src/lib/voice/*` (VAD, audio, controller), `src/components/VoiceCall.tsx` (call button in the
chat header + call screen), `src/components/VoiceSettings.tsx` (admin rows). Server: `server/src/ai/voice.ts`,
`server/src/ai/voiceConfig.ts`.

## Routes (bearer auth; all use the user's OpenRouter key, 409 `{code:'no_key'}` without one; chat routing is never sent)
| Route | Body → Response |
|---|---|
| `POST /ai/voice/transcribe` | raw audio bytes, `Content-Type` audio/wav (client sends 16 kHz mono WAV) or mp4/m4a/webm/ogg/mp3/flac; ≤ 10 MB, WAV ≤ 125 s (413) → `{ text }`. Upstream: OpenRouter `/audio/transcriptions` multipart (`file`, `model`, `response_format:'json'`), no `language` (auto-detect), no `prompt`. |
| `POST /ai/voice/speak` | `{ text }` ≤ 1000 chars (markdown/emoji/URLs stripped) → audio bytes streamed through from OpenRouter `/audio/speech`. `Content-Type: audio/mpeg`, or `audio/pcm;rate=24000` (16-bit LE mono) for pcm-only models (Gemini TTS). `response_format` = mp3 when the model lists it, else pcm; `instructions` = `voice.ttsStyle` only when the model takes it. |
| `GET /ai/voice/models` | → `{ stt: {id,name}[], tts: {id,name}[] }` (public catalog, admin pickers) |
| `GET /ai/voice/voices?model=` | → `{ voices: string[], formats: string[], instructions: boolean }` (from `/audio/speech/models/{model}`, cached 1 h) |

`AIGlobal.voice = { sttModel, ttsModel, ttsVoice, ttsStyle }` (admin, `POST /ai/global { voice: {...} }`, merged field by
field). Defaults: `openai/gpt-transcribe`, `elevenlabs/eleven-v4-turbo`, voice `sarah`.

## Client behaviour
- Tap the phone button → AudioContext created/resumed inside the tap (iOS gesture), `navigator.audioSession.type =
  'play-and-record'` when available, wake lock, mic with echo cancellation/noise suppression/AGC.
- VAD: 20 ms energy frames, adaptive noise floor, start after 80 ms of voice (240 ms + higher bar while the agent talks,
  so its own voice doesn't interrupt), end after 700 ms silence, 300 ms pre-roll, drop < 300 ms voiced, 2 min cap.
- Each user message of a call carries a constant hidden part `<context>voice call: …</context>` (short spoken answers, no
  markdown/JSON, say briefly when a card was put on screen). Not in the instructions, so the cached prefix is unchanged.
- The controller subscribes to the loop's live text (`subscribeLive`/`getLive` in loop.ts, synchronous: a React effect
  would miss batched deltas), cuts it at sentence ends (first chunk at the first sentence, later ones merged to ≥ 40
  chars), fetches TTS for each chunk at once (prefetch) and plays them in order through one AudioContext.
- Barge-in: speech while the agent talks or thinks stops playback and the loop, then the new utterance is sent.
- Call screen: orb + status + caption on top, the chat (bubbles + actionable cards) in the middle, controls at the
  bottom (Mute, Camera, Type, End). Camera: preview, flip, shutter (photo goes with the next utterance or "Send now"),
  Live (≤ 3 frames per utterance every 2 s, ≤ 24 per call, ≤ 768 px JPEG). Backgrounding the app ends the call.
- Fake mode: transcribe returns canned text; speak uses speechSynthesis, or a generated PCM tone when
  `localStorage['tapin:fakeVoicePcm']` is set. Debug hook during a call: `window.tapinVoice.say(text)`.

# Chat backup, request-card details, keyboard pin (2026-11-24) — override earlier sections where they differ

- **Chats sync** (Settings → Agent → "Back up chats", `Settings.agent.backupChats`, default on). Table `chats` is in the
  client `TABLES` and the server `SYNC_TABLES`. Writes stay in `lib/agent/chats.ts` (not `db.save`): each write bumps
  `syncAt` (the LWW stamp; `updatedAt` still only orders the list) and queues an outbox entry when backup is on.
  The server gets `syncCopy(chat)`: image/video/file parts → `[photo]` / `[video]` / `[file "name"]`, no `opaque`, long
  tool results cut to valid JSON (`{truncated, status, comment, error, preview}`), always < 60 000 chars (oldest turns
  dropped at a user turn as a last resort, behind a `<context>` marker). Chats are pushed in their own requests so a
  refused chat never blocks other tables. Pulled chats are merged with the local copy (`hydrateChat`) so placeholders
  never replace local photos. Delete / purge = tombstone (`deletedAt`, emptied), hidden by every read; local tombstones
  are dropped after 30 days. Deploy the Worker (chats in `SYNC_TABLES`) before the client.
- **Request cards** show every field that will be applied (`lib/agent/describe.ts`): hand-written renderers for
  plans / workouts / items (item keys → exercise names) / supplements / goals / journal / memory / notes / settings,
  and a full recursive key/value tree for everything else. Long actions fold behind "Details".
- **Keyboard**: with the keyboard open and focus in `.chat-screen` / `.quick-chat`, `html.kb-pin` is set: the document
  is held at 0,0 (scroll / focus pans undone), `html, body` are sized to `visualViewport.height`, and a touch guard
  blocks drags that would scroll the document (outside a scroller, or past a scroller's end). The quick-chat sheet sits
  on the keyboard's top edge. `/vvdebug` also shows `gap` = visible bottom − composer bottom.

# One-card builds, item targets, food picking (2026-11-24, from real Sol chats) — override earlier sections where they differ

- **Refs between actions** (`src/lib/agent/refs.ts`): in one `request_changes`, a later action's input may hold a string
  `"$<index>.<path>"` — index = 0-based position of an *earlier* action in the same request, path = dot path into that
  action's (deletedAt-stripped) result; negative array indexes count from the end (`"$0.id"`, `"$1.items.-1.key"`,
  `"$0.0.id"` for an array result). The whole string must be the ref and the path needs at least one field name, so
  `"$0.50"` stays text. Validation before the card: refs must point at an earlier action (else the whole request is
  refused); otherwise the ref string stays in the input and is validated as a plain string (it passes `zId`, so ids can
  be refs; a ref where a number is expected fails). Apply resolves refs in order right before each action runs, then
  validates with zod; an unresolvable ref (earlier action failed / unchecked / no such field) fails that action.
  Indexes are the request as shown — an unchecked food action keeps its index. Result: `{status:'applied', results,
  applied}` where `applied` carries the **resolved** inputs; on a failure also `failedAt` (0-based) and a `note` that tells
  the model what was applied and to propose only the missing part. Food actions may use a ref as `foodKey` (e.g.
  `foods.create` + `entries.log`); such items need grams and show as a plain card (not the editable food card).
- **Cards render refs readably** (`describeAction(a, all)` gets every action of the request): `"$0.id"` from
  `workouts.create` → "the new workout ‘Chesty’" (same for plans, exercises, foods, supplements, stacks, journal);
  an `items.add` slot ref → "Bench Press (added in step 2)"; anything else → "Id from step 1 (New workout)".
  `workouts.create` says "Exercises: Added below" when a later `items.add` targets it. A card whose fields total ≤ 20 lines
  shows every action's fields at once (no Details fold). A failed request's card shows per action Done / Failed: error /
  Not applied (`Chat.cards[id].outcomes`).
- **`items.add` per-exercise targets**: alongside `exerciseIds` + `sets` (unchanged), `items: [{ exerciseId, sets?,
  repsMin?, repsMax?, warmups?, drops?, rest?: {mode:'timer', sec?} | {mode:'countup'}, notes? }]` (the `items.update`
  patch fields; exactly one of the two forms; repsMin ≤ repsMax). The card shows one line per exercise
  ("4 × 6–8 reps · rest 3:00 · 2 warm-ups", "default rest" when not given) and the full note under it.
- **Instructions**: finish the whole task in as few cards as possible, ideally one request with every action (refs);
  never ask approval for a part "first", never end a turn with "still pending" items it could propose now; truly needed
  input → `ask_user` in the same turn. Food: read each candidate's name/alt (cooking method, added fat and which fat,
  brand) and take the closest; never describe a food as something its database name doesn't say; no "with a little oil"
  entry → the plain / no-added-fat entry + a separate oil line, never an entry with a different fat; `name` only
  translates or shortens. After logging: one line with kcal and protein eaten vs goal and what's left (`goals.get` +
  `entries.list` in one `run_query`), `show_stats` only if more helps.
- **Food card**: when an item's `name` override differs from the database names, the row shows the override with the
  database name always visible under it.
- **Food search, mixed scripts** (`src/lib/foodRank.ts`): every food name field is single-language, so a query mixing
  Hebrew and Latin words is also searched per script (Hebrew words / other words) and merged with the whole-query
  results: an item matched by both halves scores its better half + half the gap to the other (gap capped at 2) − 1.5;
  otherwise its best single score. Single-script queries rank exactly as before. Regression checks against the bundled
  databases: `scripts/check-food-search.mjs` (`npm run check:search`, also part of `npm run build`).
- **Fake provider**: "make a workout" → one request (`workouts.create` + `items.add` with `workoutId: "$0.id"` and
  per-exercise targets); "make a broken workout" → same with a bogus exercise id (fails at step 2, the workout shell stays).

# Voice latency + keyboard first-open (2026-11-25) — override earlier sections where they differ

**Effort for call turns.** `/ai/turn` accepts `effort: 'voice'` from anyone (like `'title'`); the server maps it to
`AIGlobal.voiceEffort` (new, default `'low'`, admin row "Voice calls"). The client sends it for every turn of a chat
while a call is live (`setVoiceTurns(chatId, on)` in `loop.ts`; not keyed on `Chat.voice`, which stays true after the
call). Pure resolver `resolveEffort()` in `provider.ts`. **Deploy the Worker before the client**: an older Worker
rejects the unknown effort and every call turn would fail.

**Voice config.** `VoiceConfig.ttsSpeed` (0.7–1.3, default 1.12). Default voice `chris` (ElevenLabs premade, male).
`GET /ai/voice/voices` also returns `speed: {min,max} | null` (from the speech catalog). `/ai/voice/speak` sends `speed`
only when the model lists a range (clamped); otherwise (eleven-v4 / v4-turbo: no speed control) it answers with
`X-Tapin-Speed: <factor>` (exposed via CORS) and the client time-stretches the decoded audio with pitch kept
(`src/lib/voice/stretch.ts`, WSOLA). A stored `ai_global` row without `ttsSpeed` (saved before this change) has the old
default voice `sarah` / old style dropped on load (`upgradeStoredVoice`) so the new defaults apply.

**Transcribe while talking.** OpenRouter's `/audio/transcriptions` takes whole files only (no streaming input; the
Nemotron "streaming" ASR is request/response there and slower: p50 1.24 s vs gpt-transcribe 0.70 s). So the VAD cuts
the utterance at pauses and each piece is transcribed in the background:
- VAD events `start → (segment | retract)* → end | drop`. A **segment** is cut at 260 ms of silence (once per pause,
  ≥ 250 ms voiced); one shorter than 1.2 s is **provisional**: if speech resumes it is retracted (request aborted) and
  its audio joins the next segment. End of utterance at **500 ms** silence (was 700). `end.tail` = audio after the last
  cut; it is transcribed only if it has ≥ 120 ms of voice (normally the last segment already covers everything, so
  nothing is left to send at the end). Segments + tail = the utterance exactly (no audio is sent twice except a
  retracted provisional fragment), so STT cost is ~unchanged.
- Captions fill in live from finished segments. On a failed segment the whole utterance is re-sent once.
- **End guard:** if the joined transcript doesn't end with sentence punctuation, the controller waits until 1.1 s of
  silence before sending; speech in that window is merged into the same message (also when the user starts again
  while the previous part is still being transcribed).
- **No speculative LLM start**: `sendMessage` persists the user message and the loop executes tools (auto-permitted
  writes included) as soon as the model asks; a discarded speculative turn could not be made side-effect free without a
  second, non-persisting loop. Segmented STT already removes most of the post-speech wait.

**Speaking sooner.** The first chunk of a reply goes to TTS at the first sentence end **or a clause break (comma /
dash) after ≥ 6 words**; later chunks unchanged (sentence ends, ≥ 40 chars), each requested as soon as its text is
complete. The first chunk is **hedged**: a second identical `/speak` goes out if the first hasn't answered after
1.4 s, first to finish wins (TTS p90 ≈ 2.9 s vs p50 0.9 s). Byte-streamed playback is not used: mp3 via MSE isn't
reliable on iOS and the ElevenLabs PCM sample rate behind OpenRouter isn't documented. The call note asks for the
answer first, no preamble. `VoiceCall.timings` / console `[voice] ms after speech end` log stt / send / firstText /
firstAudio per exchange.

**Keyboard (first open).** `lib/viewport.ts` re-measures every frame after focusin / vv resize / vv scroll until the
visual viewport has been unchanged for 300 ms (min 450 ms, max 2.5 s; was a fixed 900 ms), then one final pass; a 250 ms
poll while the keyboard is open (or a chat input is focused) catches changes that fire no event (iOS: the late
QuickType bar on the first show); a chat-input focusin pins the document at once (`kb-pin`) so the first keyboard is
measured against the pinned layout; `navigator.virtualKeyboard` `geometrychange` is also listened to where it exists.
`/vvdebug` shows a timestamped trace (event, vv h/top, kb, P = pinned, g = composer gap).
