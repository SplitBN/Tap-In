// Command registry — the app's programmable interface.
//
// Every action a user can take and every question they can ask of their data is a named command
// with a zod input schema and an LLM-readable description. The UI calls these commands; a future
// AI agent gets the exact same list as tools (see toolDefinitions()). Rule: no component writes to
// the database directly — it calls a command, so nothing a user can do is out of the agent's reach.
import { z } from 'zod';

export type CommandKind = 'query' | 'action';

export interface Command<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string; // dotted, e.g. "sets.log"
  kind: CommandKind; // queries never change data; actions do
  description: string; // written for a model: what it does, when to use it, what it returns
  input: I;
  run: (input: z.output<I>) => Promise<O>;
}

const commands = new Map<string, Command>();

export function defineCommand<I extends z.ZodType, O>(c: Command<I, O>): Command<I, O> {
  if (commands.has(c.name)) throw new Error(`Duplicate command ${c.name}`);
  commands.set(c.name, c as unknown as Command);
  return c;
}

/** Call a command by name with untrusted input (validated). Used by the agent bridge and tests. */
export async function call(name: string, input: unknown = {}) {
  // tool-use names replace dots with underscores (plans_list) — accept both
  const c = commands.get(name) ?? commands.get(name.replace(/_/g, '.')) ?? listCommands().find((x) => x.name.replace(/\./g, '_') === name);
  if (!c) throw new Error(`Unknown command "${name}". Use listCommands() to see what exists.`);
  const parsed = c.input.safeParse(input ?? {});
  if (!parsed.success) throw new Error(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
  const out = await c.run(parsed.data);
  // agent-facing output: drop internal soft-delete markers
  return out === undefined ? { ok: true } : JSON.parse(JSON.stringify(out, (k, v) => (k === 'deletedAt' ? undefined : v)));
}

/** Typed call for app code: the command object itself carries the types. */
export function run<I extends z.ZodType, O>(c: Command<I, O>, input: z.input<I>): Promise<O> {
  return c.run(c.input.parse(input));
}

export const listCommands = () => [...commands.values()];

/** Tool definitions for an LLM (JSON Schema per command), e.g. Anthropic / OpenAI tool format. */
export function toolDefinitions() {
  return listCommands().map((c) => ({
    name: c.name.replace(/\./g, '_'),
    description: `[${c.kind}] ${c.description}`,
    input_schema: (({ $schema: _s, ...rest }) => rest)(z.toJSONSchema(c.input, { io: 'input' }) as Record<string, unknown>),
  }));
}

// ---- shared schemas ----
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Local calendar date YYYY-MM-DD');
export const zId = z.string().min(1).describe('Record id');
export const zTime = z.string().regex(/^\d{2}:\d{2}$/).describe('Local time HH:MM');
export const zMeal = z.enum(['breakfast', 'lunch', 'dinner', 'snacks']);
