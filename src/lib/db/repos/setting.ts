import type Database from 'better-sqlite3';
import type { SettingRow } from '../schema';

type Db = InstanceType<typeof Database>;

export interface SettingRepo {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  // 11-03 SR1: explicit row deletion for the preset-null path on bench/apply.
  // No-op when the row is absent (idempotent semantics).
  delete(key: string): void;
  getAll(): Record<string, string>;
}

export function makeSettingRepo(db: Db): SettingRepo {
  const getStmt = db.prepare<[string], { value: string }>(
    'SELECT value FROM setting WHERE key = ?',
  );
  const upsertStmt = db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CAST(strftime('%s','now') AS INTEGER)`,
  );
  const deleteStmt = db.prepare('DELETE FROM setting WHERE key = ?');
  const allStmt = db.prepare<[], SettingRow>('SELECT * FROM setting');

  // 28-03 (P8): closure-level cache for getAll(). settingRepo() is a memoized
  // singleton (src/lib/db/index.ts) AND every setting writer routes through
  // set()/delete() below (grep-confirmed: no raw UPDATE/INSERT against `setting`
  // outside this file), so invalidating the cache on every mutation keeps it
  // EXACT — never eventually-stale, no TTL needed. The cached record is frozen
  // (MH-3) so a downstream consumer that accidentally mutates it cannot poison
  // a later cache hit. The db-reset path nulls _settingRepo (index.ts), so a
  // reset rebuilds this closure with a fresh empty cache (SR-1).
  let allCache: Record<string, string> | null = null;

  return {
    get(key: string): string | undefined {
      return getStmt.get(key)?.value;
    },

    set(key: string, value: string): void {
      upsertStmt.run(key, value);
      allCache = null;
    },

    delete(key: string): void {
      deleteStmt.run(key);
      allCache = null;
    },

    getAll(): Record<string, string> {
      if (allCache) return allCache;
      const rows = allStmt.all();
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key] = row.value;
      Object.freeze(out);
      allCache = out;
      return allCache;
    },
  };
}
