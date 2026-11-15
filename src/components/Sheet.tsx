import { AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

// Bottom sheet. Drag the grabber/header down to dismiss: tracks 1:1, projects momentum on release
// (apple-design §5–6), springs back or out. Enters and exits along the same path (§7).
const SPRING = { type: 'spring', bounce: 0.15, duration: 0.35 } as const;

// Sheets can stack (picker → new exercise), so the page stays inert until the last one closes.
let openSheets = 0;
function setInert(d: number) {
  openSheets = Math.max(0, openSheets + d);
  const app = document.querySelector('.app');
  if (app) app.toggleAttribute('inert', openSheets > 0);
}

function project(v: number, d = 0.998) {
  return ((v / 1000) * d) / (1 - d);
}

export function Sheet({ open, onClose, title, children, full, actions }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; full?: boolean; actions?: ReactNode;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();

  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Modal focus: block the page behind (inert), move focus into the sheet unless a field
  // inside already autofocused, and give focus back to the opener on close (WCAG 2.4.3).
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    setInert(+1);
    const raf = requestAnimationFrame(() => {
      const el = sheetRef.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      setInert(-1);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const projected = info.offset.y + project(info.velocity.y);
    if (projected > 160) onClose();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="scrim" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.div
            ref={sheetRef} tabIndex={-1}
            className={'sheet' + (full ? ' full' : '')}
            role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
            initial={reduce ? { opacity: 0 } : { y: '100%' }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: '100%' }}
            transition={SPRING}
            drag="y" dragControls={controls} dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.05, bottom: 1 }}
            onDragEnd={onDragEnd}
          >
            <div onPointerDown={(e) => controls.start(e)} style={{ touchAction: 'none' }}>
              <div className="sheet-grab" />
              {(title || actions) && (
                <div className="sheet-head">
                  <h2>{title}</h2>
                  {actions}
                  <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
                </div>
              )}
            </div>
            <div className="sheet-body">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
