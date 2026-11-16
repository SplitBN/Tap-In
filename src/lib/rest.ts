import { useEffect, useState, useSyncExternalStore } from 'react';
import * as sync from './sync';

// Rest timer state. Timestamp-based so it stays correct when the phone sleeps or the app is backgrounded.
// Kept in localStorage (a per-device convenience, not data) so a reload mid-rest keeps the timer.
// sessionId / setRef tie it to the workout and set that started it, so a new workout or un-checking that set stops it.
export interface RestState { startedAt: number; targetSec?: number; label?: string; sessionId?: string; setRef?: string }
const KEY = 'tapin:rest';
const ALERT_KEY = 'tapin:restAlert'; // a lock-screen push may be scheduled on the server (value: its end time)
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
const alertPending = () => { try { return localStorage.getItem(ALERT_KEY) != null; } catch { return false; } };
const setAlertPending = (at: number | null) => { try { at == null ? localStorage.removeItem(ALERT_KEY) : localStorage.setItem(ALERT_KEY, String(at)); } catch { /* private mode */ } };

export const rest = {
  start: (targetSec?: number, label?: string, ref?: { sessionId: string; setRef: string }) => {
    write({ startedAt: Date.now(), targetSec, label, ...ref }); void sync.warmPushEndpoint();
  },
  stop: () => write(null),
  adjust: (deltaSec: number) => state && write({ ...state, targetSec: Math.max(0, (state.targetSec ?? 0) + deltaSec) }),
  current: () => state,
  /** Stop only if this timer was started by that set (un-checking it). */
  stopIfFrom: (sessionId: string, setRef: string) => { if (state?.sessionId === sessionId && state.setRef === setRef) write(null); },
};

// Lock-screen alert: iOS can't show a live timer for web apps, so when the app is hidden mid-rest the server
// sends one push at the exact end time. Cancelled as soon as the app is visible again (the in-app timer takes over),
// so the two never alert together. Only scheduled when the app goes to the background — not on every rest.
// The "may be scheduled" flag lives in localStorage, so if iOS killed the app in the background the cancel is
// still sent on the next start; it is cleared only once the cancel actually went out.
async function cancelPendingAlert() {
  if (!alertPending()) return;
  if (await sync.cancelRestAlert()) setAlertPending(null);
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const s = state; const end = s?.targetSec ? s.startedAt + s.targetSec * 1000 : 0;
      if (s && end > Date.now() + 3000) {
        setAlertPending(end);
        void sync.scheduleRestAlert(end, 'Rest over', s.label ? `${s.label} · next set` : 'Time for your next set');
      }
    } else void cancelPendingAlert();
  });
  void cancelPendingAlert(); // app (re)started: a push from before a background kill may still be queued
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
