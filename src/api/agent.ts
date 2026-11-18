// Agent preferences. Never offered to the agent itself (blocked in lib/agent/tools.ts): a web page must not be able
// to talk the agent into switching a category to auto-apply.
import { z } from 'zod';
import { defineCommand } from './registry';
import { getSettings, updateSettings } from '../db/settings';

const zPerm = z.enum(['ask', 'auto']);

export const agentPrefsUpdate = defineCommand({ name: 'agentPrefs.update', kind: 'action',
  description: 'Settings-only: change the assistant preferences — permissions per category (ask / auto) and web (web tools). Not available to the assistant.',
  input: z.object({
    permissions: z.object({ food: zPerm, gym: zPerm, supplements: zPerm, body: zPerm, journal: zPerm, settings: zPerm }).partial().optional(),
    web: z.boolean().optional(),
  }),
  run: async ({ permissions, web }) => {
    const s = await getSettings();
    const agent = { ...s.agent, ...(web !== undefined ? { web } : {}), permissions: { ...s.agent?.permissions, ...permissions } };
    await updateSettings({ agent });
    return agent;
  } });
