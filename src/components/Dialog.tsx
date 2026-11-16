import { useId, useSyncExternalStore } from 'react';
import { Sheet } from './Sheet';

// In-app confirm/notice. Browser confirm()/alert() can be suppressed (embedded views, some
// standalone contexts) and look foreign, so every confirmation goes through this sheet.
interface Req { title: string; message?: string; confirm?: string; cancel?: string | null; danger?: boolean; resolve: (ok: boolean) => void }
let req: Req | null = null;
const subs = new Set<() => void>();
const set = (r: Req | null) => { req = r; subs.forEach((f) => f()); };

export function confirmDialog(o: Omit<Req, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => set({ ...o, resolve }));
}
export const notice = (title: string, message?: string) => confirmDialog({ title, message, confirm: 'OK', cancel: null });

export function DialogHost() {
  const r = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => req);
  const done = (ok: boolean) => { r?.resolve(ok); set(null); };
  const titleId = useId();
  const msgId = useId();
  // destructive: focus lands on Cancel, so a stray Enter never deletes anything
  const safeFirst = !!r?.danger && r.cancel !== null;
  return (
    <Sheet open={!!r} onClose={() => done(false)} labelledBy={titleId}>
      {r && (
        <div className="stack" style={{ gap: 16, paddingTop: 4 }}>
          <div>
            <h2 id={titleId} className="t-20" style={{ margin: 0, letterSpacing: '-0.01em' }}>{r.title}</h2>
            {r.message && <p id={msgId} className="muted" style={{ margin: '6px 0 0', lineHeight: 1.5 }}>{r.message}</p>}
          </div>
          <div className="stack">
            <button className={'btn lg block ' + (r.danger ? 'danger-solid' : 'primary')} onClick={() => done(true)} autoFocus={!safeFirst}>{r.confirm ?? 'Confirm'}</button>
            {r.cancel !== null && <button className="btn lg block" onClick={() => done(false)} autoFocus={safeFirst}>{r.cancel ?? 'Cancel'}</button>}
          </div>
        </div>
      )}
    </Sheet>
  );
}
