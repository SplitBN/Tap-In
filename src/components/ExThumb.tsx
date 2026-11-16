// Exercise photo as a soft rounded rectangle (4:3, like the reference app), or initials when there is none.
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { exerciseImage } from '../db/seed';
import type { Exercise } from '../db/types';

const initials = (name = '?') => name.split(/[\s-]+/).filter((w) => /^[a-z0-9]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export function ExThumb({ ex, size = 'md' }: { ex?: Pick<Exercise, 'name' | 'images'>; size?: 'sm' | 'md' | 'lg' }) {
  const src = exerciseImage(ex);
  return src
    ? <img className={'ex-thumb ' + size} src={src} alt="" loading="lazy" />
    : <span className={'ex-thumb ini ' + size} aria-hidden>{initials(ex?.name)}</span>;
}

/** Up to `max` exercise thumbnails in a pill, then "+N" (Gym tab workout rows). */
export function ThumbPill({ ids, max = 3 }: { ids: string[]; max?: number }) {
  const exs = useLiveQuery(() => db.exercises.bulkGet(ids.slice(0, max)), [ids.slice(0, max).join()]) ?? [];
  if (!ids.length) return null;
  return (
    <span className="thumb-pill" aria-hidden>
      {exs.map((e, i) => <ExThumb key={i} ex={e} size="sm" />)}
      {ids.length > max && <span className="thumb-more num">+{ids.length - max}</span>}
    </span>
  );
}
