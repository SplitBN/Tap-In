// Agent preferences. Never offered to the agent itself (see AGENT_BLOCKED in lib/agent/tools.ts): a web page
// must not be able to talk the agent into turning off "Ask before changes".
import { z } from 'zod';
import { defineCommand } from './registry';
import { getSettings, updateSettings } from '../db/settings';

export const agentPrefsUpdate = defineCommand({ name: 'agentPrefs.update', kind: 'action',
  description: 'Settings-only: change the assistant preferences ask (ask before changes) and web (web tools). Not available to the assistant.',
  input: z.object({ ask: z.boolean().optional(), web: z.boolean().optional() }),
  run: async (p) => {
    const s = await getSettings();
    const agent = { ...s.agent, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) };
    await updateSettings({ agent });
    return agent;
  } });
