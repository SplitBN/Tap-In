import { changed, db, type SyncedTable } from '../db/db';

// Every table in a backup is a synced table, so imported rows are queued for sync like any local write.
export const BACKUP_TABLES = ['exercises', 'plans', 'workouts', 'sessions', 'sets', 'bodyweight', 'settings', 'foods', 'entries', 'days', 'goals', 'supplements', 'stacks', 'supplogs', 'notes', 'memories'] as const satisfies readonly SyncedTable[];

export interface Backup { app: 'tap-in'; version: number; exportedAt: string; data: Record<string, { id: string }[]> }

/** Full backup object (custom/edited exercises only; the bundled library is re-seeded). Used by the data.export command. */
export async function buildBackup(): Promise<Backup> {
  const out: Backup['data'] = {};
  for (const t of BACKUP_TABLES) {
    const rows = await db.table(t).toArray();
    out[t] = t === 'exercises' ? rows.filter((r) => r.custom || r.updatedAt > 0) : rows;
  }
  return { app: 'tap-in', version: 1, exportedAt: new Date().toISOString(), data: out };
}

/** Write records from a backup (replace by id) and queue each for sync. Used by the data.import command. Returns the record count. */
export async function restoreBackup(data: Record<string, { id: string }[] | undefined>) {
  let n = 0;
  const now = Date.now();
  await db.transaction('rw', [...BACKUP_TABLES.map((t) => db.table(t)), db.outbox], async () => {
    for (const t of BACKUP_TABLES) {
      const rows = data[t];
      if (!Array.isArray(rows) || !rows.length) continue;
      // stamp as changed now so last-write-wins sync lets the restored copy win over older server copies
      await db.table(t).bulkPut(rows.map((r) => ({ ...r, updatedAt: now })));
      await db.outbox.bulkAdd(rows.map((r) => ({ table: t, recordId: r.id, at: now })));
      n += rows.length;
    }
  });
  changed();
  return n;
}

/** Hand a backup to the user: share sheet on iPhone (save to Files/iCloud Drive), plain download on desktop. */
export async function saveBackupFile(backup: Backup) {
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const name = `tap-in-backup-${backup.exportedAt.slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* cancelled → fall back */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Read a picked backup file; friendly error for anything that isn't one. */
export async function readBackupFile(file: File) {
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch { throw new Error('Not a Tap In backup'); }
  if ((parsed as { app?: unknown } | null)?.app !== 'tap-in') throw new Error('Not a Tap In backup');
  return parsed as Backup;
}
