import { AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo } from 'motion/react';
import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

// Bottom sheet. Drag the grabber/header down to dismiss: tracks 1:1, projects momentum on release
// (apple-design §5–6), springs back or out. Enters and exits along the same path (§7).
const SPRING = { type: 'spring', bounce: 0.15, duration: 0.35 } as const;
const BACK = { type: 'spring', bounce: 0, duration: 0.35 } as const;

export type SheetRole = 'gym' | 'weight' | 'food' | 'supp' | 'neutral';

/* ---- sheet stack ----
   Sheets can stack (picker → new exercise). One module-level stack decides:
   - which sheet is on top (only it gets Escape, only it is interactive),
   - depth (z-index, the parent scales back like iOS, one dim scrim per stack),
   - inert: the app (#root: page, tab bar, fab, rest bar) and every lower sheet. */
interface Entry { id: string; close: () => void }
let stack: Entry[] = [];
const subs = new Set<() => void>();
const emit = () => { stack = [...stack]; subs.forEach((f) => f()); applyInert(); };
const useStack = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => stack);

function applyInert() {
  document.getElementById('root')?.toggleAttribute('inert', stack.length > 0);
  const top = stack[stack.length - 1]?.id;
  document.querySelectorAll<HTMLElement>('.sheet[data-sheet]').forEach((el) => el.toggleAttribute('inert', el.dataset.sheet !== top));
}

// one Escape handler for the whole app: it closes only the top sheet
if (typeof window !== 'undefined') {
  const w = window as unknown as { __tapinSheetEsc?: boolean };
  if (!w.__tapinSheetEsc) {
    w.__tapinSheetEsc = true;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !stack.length) return;
      e.preventDefault();
      stack[stack.length - 1].close();
    });
  }
}

const RoleCtx = createContext<SheetRole | undefined>(undefined);

function project(v: number, d = 0.998) {
  return ((v / 1000) * d) / (1 - d);
}

const roleFromOpener = (): SheetRole | undefined =>
  ((document.activeElement as HTMLElement | null)?.closest?.('[data-role]')?.getAttribute('data-role') as SheetRole | null) ?? undefined;

export function Sheet({ open, onClose, title, children, full, actions, role, labelledBy }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; full?: boolean; actions?: ReactNode;
  /** area colour for primary/selected controls inside; default: the parent sheet's, else the opener's area */
  role?: SheetRole;
  /** id of a heading inside the body that names the dialog (when there is no title) */
  labelledBy?: string;
}) {
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const id = useId();
  const headId = useId();
  const parentRole = useContext(RoleCtx);
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // the area colour is decided once per opening (prop > parent sheet > the control that opened it)
  const [autoRole, setAutoRole] = useState<SheetRole | undefined>();
  const [wasOpen, setWasOpen] = useState(false);
  // the opener is read here, during render: an autoFocus field inside the sheet takes focus at commit, before effects
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  if (open !== wasOpen) { setWasOpen(open); if (open) { setAutoRole(roleFromOpener()); setOpener(document.activeElement as HTMLElement | null); } }
  const areaRole = role ?? parentRole ?? autoRole;

  const st = useStack();
  const depth = st.findIndex((e) => e.id === id);
  const above = depth < 0 ? 0 : st.length - 1 - depth;
  const lastDepth = useRef(0); // kept while the sheet animates out, so it stays above its parent
  if (depth >= 0) lastDepth.current = depth;

  // Modal focus: join the stack (page + lower sheets go inert), move focus into the sheet unless a field
  // inside already autofocused, and give focus back to the opener on close (WCAG 2.4.3).
  useEffect(() => {
    if (!open) return;
    stack.push({ id, close: () => closeRef.current() });
    emit();
    const raf = requestAnimationFrame(() => {
      const el = sheetRef.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      stack = stack.filter((e) => e.id !== id);
      emit();
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
      else { // the opener went away with a sheet that closed at the same time: land on the top sheet left
        const top = stack[stack.length - 1];
        if (top) document.querySelector<HTMLElement>(`.sheet[data-sheet="${CSS.escape(top.id)}"]`)?.focus({ preventScroll: true });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id]);

  // inert has to be re-applied once the sheet's element exists (it mounts after the stack changed)
  useEffect(() => { if (open) applyInert(); });

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const projected = info.offset.y + project(info.velocity.y);
    if (projected > 160) onClose();
  };

  const z = 40 + lastDepth.current * 2;
  const covered = above > 0;
  const named = typeof title === 'string' ? undefined : title ? headId : labelledBy;

  return createPortal(
    <AnimatePresence>
      {open && (
        <RoleCtx.Provider value={areaRole}>
          {/* one dim scrim per stack: sheets on top of another get a clear one (tap still closes the top sheet) */}
          <motion.div className="scrim" onClick={onClose} style={{ zIndex: z, background: lastDepth.current > 0 ? 'transparent' : undefined }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.div
            ref={sheetRef} tabIndex={-1} data-sheet={id} data-role={areaRole}
            className={'sheet' + (full ? ' full' : '')} style={{ zIndex: z + 1, transformOrigin: 'top center' }}
            role="dialog" aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined} aria-labelledby={named}
            initial={reduce ? { opacity: 0 } : { y: '100%' }}
            animate={reduce ? { opacity: covered ? 0.7 : 1 } : { y: covered ? -8 : 0, scale: covered ? 0.94 : 1, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: '100%', scale: 1 }}
            transition={reduce ? { duration: 0.2 } : covered ? BACK : SPRING}
            drag={covered ? false : 'y'} dragControls={controls} dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.05, bottom: 1 }}
            onDragEnd={onDragEnd}
          >
            <div onPointerDown={(e) => controls.start(e)} style={{ touchAction: 'none' }}>
              <div className="sheet-grab" />
              {(title || actions) && (
                <div className="sheet-head">
                  <h2 id={headId}>{title}</h2>
                  {actions}
                  <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
                </div>
              )}
            </div>
            <div className="sheet-body">{children}</div>
          </motion.div>
        </RoleCtx.Provider>
      )}
    </AnimatePresence>,
    document.body,
  );
}
