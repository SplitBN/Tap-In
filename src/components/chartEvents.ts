// Event stamps for the progress charts (exercise + weight): journal entries and supplement on-periods from the
// timeline.events command, as TimeChart events (ms times; to: undefined = single day, null = ongoing).
import { useLiveQuery } from 'dexie-react-hooks';
import { run } from '../api/registry';
import { timelineEvents } from '../api/journal';
import { keyToDate } from '../lib/nutrition';
import type { TEvent } from './TimeChart';

const DAY = 864e5;
export function useChartEvents(): TEvent[] | undefined {
  return useLiveQuery(async () => (await run(timelineEvents, {})).map((e) => ({
    id: e.id, kind: e.kind, label: e.label, icon: e.icon, t: keyToDate(e.from).getTime(),
    to: e.to === null ? null : e.to === e.from ? undefined : keyToDate(e.to).getTime() + DAY - 1,
  })), []);
}
