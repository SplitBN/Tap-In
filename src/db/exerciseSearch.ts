import { db } from './db';
import type { Usage } from '../lib/exerciseRank';
export { exerciseTokens, searchExercises, STAPLES, type Usage } from '../lib/exerciseRank';

/** Sessions each exercise was done in (completed sets) and when last — your staples float up. */
export async function exerciseUsage(): Promise<Usage> {
  const m = new Map<string, { n: number; last: number; sessions: Set<string> }>();
  await db.sets.each((s) => {
    if (!s.doneAt || s.deletedAt) return;
    const u = m.get(s.exerciseId) ?? { n: 0, last: 0, sessions: new Set<string>() };
    if (!u.sessions.has(s.sessionId)) { u.sessions.add(s.sessionId); u.n++; }
    u.last = Math.max(u.last, s.doneAt); m.set(s.exerciseId, u);
  });
  return m;
}

