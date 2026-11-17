// The agent's notebook. Shared by Settings → Agent → Memory and the agent's memory_* tools.
import { z } from 'zod';
import { defineCommand, zId } from './registry';
import { alive, db, newRecord, remove, save } from '../db/db';
import type { Memory } from '../db/types';

const view = (m: Memory) => ({ id: m.id, name: m.name, description: m.description, content: m.content, updatedAt: new Date(m.updatedAt).toISOString() });

export const memoryList = defineCommand({ name: 'memory.list', kind: 'query',
  description: 'All saved memories (the assistant\'s notebook about the user): id, name, one-line description, last change. Content is not included; use memory.get.',
  input: z.object({}),
  run: async () => (await db.memories.filter(alive).toArray()).sort((a, b) => b.updatedAt - a.updatedAt)
    .map((m) => ({ id: m.id, name: m.name, description: m.description, updatedAt: new Date(m.updatedAt).toISOString() })) });

export const memoryGet = defineCommand({ name: 'memory.get', kind: 'query', description: 'One memory with its full content, or null.',
  input: z.object({ id: zId }), run: async ({ id }) => { const m = await db.memories.get(id); return m && alive(m) ? view(m) : null; } });

export const memorySave = defineCommand({ name: 'memory.save', kind: 'action',
  description: 'Create (no id) or overwrite (id) a memory: name (short title), description (one line: when it is useful), content (the note itself). Returns the memory.',
  input: z.object({ id: zId.optional(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(200).default(''), content: z.string().trim().min(1).max(4000) }),
  run: async ({ id, name, description, content }) => {
    if (id) {
      const m = await db.memories.get(id);
      if (!m || !alive(m)) throw new Error(`No memory with id "${id}"`);
      return view(await save('memories', { ...m, name, description, content }));
    }
    return view(await save('memories', newRecord({ name, description, content })));
  } });

export const memoryDelete = defineCommand({ name: 'memory.delete', kind: 'action', description: 'Delete a memory.',
  input: z.object({ id: zId }), run: async ({ id }) => { await remove('memories', id); return { ok: true }; } });
