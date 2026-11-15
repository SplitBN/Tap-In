import { useEffect, useState, useSyncExternalStore } from 'react';

// Rest timer state. Timestamp-based so it stays correct when the phone sleeps or the app is backgrounded.
// Kept in localStorage (a per-device convenience, not data) so a reload mid-rest keeps the timer.
export interface RestState { startedAt: number; targetSec?: number; label?: string }
const KEY = 'tapin:rest';
let state: RestState | null = read();
const subs = new Set<() => void>();

function read(): RestState | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
function write(s: RestState | null) {
  state = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  subs.forEach((f) => f());
}

export const rest = {
  start: (targetSec?: number, label?: string) => write({ startedAt: Date.now(), targetSec, label }),
  stop: () => write(null),
  adjust: (deltaSec: number) => state && write({ ...state, targetSec: Math.max(0, (state.targetSec ?? 0) + deltaSec) }),
};

export function useRest() {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state);
}

/** Re-renders every `ms` while `active`. */
export function useTick(active: boolean, ms = 250) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return Date.now();
}

/** Keep the screen on during a workout (Screen Wake Lock, iOS 18.4+). Re-acquires after the app returns. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const get = async () => { try { lock = await navigator.wakeLock.request('screen'); } catch { /* denied/unsupported */ } };
    const onVis = () => document.visibilityState === 'visible' && get();
    get();
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); lock?.release().catch(() => {}); };
  }, [active]);
}
