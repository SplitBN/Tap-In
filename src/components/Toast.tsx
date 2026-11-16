import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

// Undo toast: "Weigh-in deleted · Undo". Deletes act at once and offer undo here instead of asking first.
// The live region (role=status) is always mounted, so screen readers announce each new message.
// Portaled to <body>, outside #root, so it stays reachable while a sheet makes the app inert.
interface T { id: number; text: string; undo?: () => unknown }
let cur: T | null = null;
let seq = 0;
const subs = new Set<() => void>();
const set = (t: T | null) => { cur = t; subs.forEach((f) => f()); };

export function toast(text: string, undo?: () => unknown) { set({ id: ++seq, text, undo }); }

const SHOW_MS = 8000;

export function ToastHost() {
  const t = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => cur);
  const hold = useRef(false); // paused while hovered or focused
  useEffect(() => {
    if (!t) return;
    let left = SHOW_MS;
    // focus was lost with the deleted row (its sheet closed): offer Undo as the next stop instead of the page top
    const raf = window.setTimeout(() => { if (t.undo && (document.activeElement === document.body || !document.activeElement)) document.querySelector<HTMLElement>(".toast-undo")?.focus({ preventScroll: true }); }, 400); // after the deleted row has left the list
    const iv = setInterval(() => { if (!hold.current) left -= 250; if (left <= 0) set(null); }, 250);
    return () => { clearInterval(iv); clearTimeout(raf); };
  }, [t]);
  return createPortal(
    <div className="toast-wrap">
      <div className="sr-only" role="status">{t ? t.text : ''}</div>
      <AnimatePresence>
        {t && (
          <motion.div key={t.id} className="toast" initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 12, filter: 'blur(4px)', transition: { duration: 0.15 } }} transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            onPointerEnter={() => (hold.current = true)} onPointerLeave={() => (hold.current = false)}
            onFocus={() => (hold.current = true)} onBlur={() => (hold.current = false)}>
            <span className="grow" aria-hidden>{t.text}</span>
            {t.undo && <button className="toast-undo" onClick={async () => { const u = t.undo!; set(null); await u(); }}>Undo</button>}
            <button className="icon-btn sm" aria-label="Dismiss" onClick={() => set(null)}><Icon name="close" size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
