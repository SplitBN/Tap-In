// Agent-ready rule guard: screens (src/pages, src/components) must change data only through commands
// (src/api, via run()), so everything a user can do is also callable by the agent. Runs before every build.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WRITE_HELPERS = ['save', 'remove', 'updateSettings', 'logTake', 'undoTake', 'createPlan', 'createWorkout', 'startSession', 'finishSession', 'logEntry', 'quickAdd', 'restoreBackup'];
const dirs = ['src/pages', 'src/components'];
const bad = [];

for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((x) => /\.tsx?$/.test(x))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/(db|lib)\/[^']+'/g)) {
      const names = m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
      for (const n of names) if (WRITE_HELPERS.includes(n)) bad.push(`${dir}/${f}: imports write helper "${n}" — call a command from src/api with run() instead`);
    }
    if (/\.(put|bulkPut|add|bulkAdd|update|delete|bulkDelete|modify|clear)\(/.test(src.replace(/\b(classList|searchParams|[a-z]*[sS]et|seen|hits|sessions|subs|listeners)\.(add|delete)\(/g, '')) && /\bdb\./.test(src)) {
      for (const [i, line] of src.split('\n').entries())
        if (/\bdb\.\w+\.(put|bulkPut|add|bulkAdd|update|delete|bulkDelete|modify|clear)\(/.test(line)) bad.push(`${dir}/${f}:${i + 1}: writes to the database directly`);
    }
  }
}

if (bad.length) { console.error('Direct database writes in screens:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('check-no-direct-writes: ok');
