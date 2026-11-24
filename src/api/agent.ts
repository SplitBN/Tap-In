// Agent preferences. Never offered to the agent itself (blocked in lib/agent/tools.ts): a web page must not be able
// to talk the agent into switching a category to auto-apply.
import { z } from 'zod';
import { defineCommand } from './registry';
import { getSettings, updateSettings } from '../db/settings';
import { queueAllChats } from '../lib/agent/chats';

const zPerm = z.enum(['ask', 'auto']);

export const agentPrefsUpdate = defineCommand({ name: 'agentPrefs.update', kind: 'action',
  description: 'Settings-only: change the assistant preferences — permissions per category (ask / auto), web (web tools) and backupChats (sync chats). Not available to the assistant.',
  input: z.object({
    permissions: z.object({ food: zPerm, gym: zPerm, supplements: zPerm, body: zPerm, journal: zPerm, settings: zPerm }).partial().optional(),
    web: z.boolean().optional(),
    backupChats: z.boolean().optional().describe('back up chats to the account (sync); attachments stay on the device'),
  }),
  run: async ({ permissions, web, backupChats }) => {
    const s = await getSettings();
    const was = s.agent?.backupChats !== false;
    const agent = { ...s.agent, ...(web !== undefined ? { web } : {}), ...(backupChats !== undefined ? { backupChats } : {}), permissions: { ...s.agent?.permissions, ...permissions } };
    await updateSettings({ agent });
    if (backupChats && !was) await queueAllChats(); // switched back on: upload every chat (changes made while off weren't queued)
    return agent;
  } });
