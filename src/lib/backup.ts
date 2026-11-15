import { db } from '../db/db';

const TABLES = ['exercises', 'plans', 'workouts', 'sessions', 'sets', 'bodyweight', 'settings'] as const;

/** Full JSON export (custom/edited exercises only; the bundled library is re-seeded on import). */
export async function exportJson() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const rows = await db.table(t).toArray();
    out[t] = t === 'exercises' ? rows.filter((r) => r.custom || r.updatedAt > 0) : rows;
  }
  const blob = new Blob([JSON.stringify({ app: 'tap-in', version: 1, exportedAt: new Date().toISOString(), data: out })], { type: 'application/json' });
  const name = `tap-in-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  // iPhone: the share sheet lets you save to Files/iCloud Drive. Desktop: plain download.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* cancelled → fall back */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importJson(file: File) {
  const parsed = JSON.parse(await file.text());
  if (parsed?.app !== 'tap-in') throw new Error('Not a Tap In backup');
  let n = 0;
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      const rows = parsed.data?.[t];
      if (Array.isArray(rows)) { await db.table(t).bulkPut(rows); n += rows.length; }
    }
  });
  return n;
}
