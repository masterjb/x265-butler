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

  return {
    get(key: string): string | undefined {
      return getStmt.get(key)?.value;
    },

    set(key: string, value: string): void {
      upsertStmt.run(key, value);
    },

    delete(key: string): void {
      deleteStmt.run(key);
    },

    getAll(): Record<string, string> {
      const rows = allStmt.all();
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    },
  };
}
