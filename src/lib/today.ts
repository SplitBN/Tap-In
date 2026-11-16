import { useSyncExternalStore } from 'react';
import { dateKey } from './nutrition';

// Today's local date key (YYYY-MM-DD) as a shared store, so screens roll over to the new day while the app stays
// open: re-checked when the app becomes visible again (iOS freezes timers in the background) and by a timer
// armed for the next local midnight. One timer for the whole app, however many screens use it.
let today = dateKey();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function check() {
  const now = dateKey();
  if (now !== today) { today = now; subs.forEach((f) => f()); }
  arm();
}
function arm() {
  clearTimeout(timer);
  const next = new Date(); next.setHours(24, 0, 1, 0); // just past local midnight
  timer = setTimeout(check, Math.min(next.getTime() - Date.now(), 2 ** 31 - 1));
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('focus', check);
  arm();
}

const subscribe = (f: () => void) => { subs.add(f); check(); return () => { subs.delete(f); }; };
/** Today's date key; re-renders the caller when the local date changes. */
export const useToday = () => useSyncExternalStore(subscribe, () => today);
