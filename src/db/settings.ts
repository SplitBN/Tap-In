import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  unit: 'kg',
  effortMode: 'rir',
  restCompoundSec: 180, // user's choice; see docs/SPEC.md "Science sources"
  restIsolationSec: 90,
  weighInEveryDays: 7,
  features: {
    gym: true,
    food: false, // not built yet
    supplements: false, // not built yet
    checkins: false,
    progressPhotos: false,
    restTimer: true,
    effort: true,
    warmups: true,
  },
};

export function useSettings(): Settings {
  const s = useLiveQuery(() => db.settings.get('settings'), []);
  return { ...DEFAULT_SETTINGS, ...s, features: { ...DEFAULT_SETTINGS.features, ...s?.features } };
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return { ...DEFAULT_SETTINGS, ...s, features: { ...DEFAULT_SETTINGS.features, ...s?.features } };
}

export async function updateSettings(patch: Partial<Settings>) {
  const cur = await getSettings();
  await db.settings.put({ ...cur, ...patch, features: { ...cur.features, ...patch.features } });
}
