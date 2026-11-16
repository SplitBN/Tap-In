import { useEffect, useState, useSyncExternalStore } from 'react';
import * as sync from './sync';

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
  start: (targetSec?: number, label?: string) => { write({ startedAt: Date.now(), targetSec, label }); void sync.warmPushEndpoint(); },
  stop: () => write(null),
  adjust: (deltaSec: number) => state && write({ ...state, targetSec: Math.max(0, (state.targetSec ?? 0) + deltaSec) }),
};

// Lock-screen alert: iOS can't show a live timer for web apps, so when the app is hidden mid-rest the server
// sends one push at the exact end time. Cancelled as soon as the app is visible again (the in-app timer takes over),
// so the two never alert together. Only scheduled when the app goes to the background — not on every rest.
let scheduled = false;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const s = state; const end = s?.targetSec ? s.startedAt + s.targetSec * 1000 : 0;
      if (s && end > Date.now() + 3000) {
        scheduled = true;
        void sync.scheduleRestAlert(end, 'Rest over', s.label ? `${s.label} · next set` : 'Time for your next set');
      }
    } else if (scheduled) {
      scheduled = false;
      void sync.cancelRestAlert();
    }
  });
}

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
