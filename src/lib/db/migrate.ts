// audit-added S8: INVARIANT — never rename a committed migration file.
// The runner identifies migrations by the leading integer in the filename;
// renaming a file the runner has already applied makes it look like a new
// migration and re-runs it. Always add a NEW migration with a higher version
// instead.

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIR_NAME = 'migrations';

function defaultMigrationsDir(): string {
  return path.join(process.cwd(), MIGRATIONS_DIR_NAME);
}

function parseVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (!match) {
    throw new Error(`migration filename does not start with NNNN_ pattern: ${filename}`);
  }
  return parseInt(match[1], 10);
}

type Db = InstanceType<typeof Database>;

// 16-05 S5: per-migration apply-result for audit-log emission. `rowsAffected`
// captures `SELECT changes()` after the migration's SQL runs, which reflects
// the last INSERT/UPDATE/DELETE statement's row-count. Callers (db/index.ts)
// can correlate version → rowsAffected to emit structured logs for
// migrations whose data-effect needs operator visibility (e.g. 0028's
// UPDATE WHERE legacy-default that may or may not have matched the existing
// row depending on operator customization).
export type AppliedMigration = { version: number; rowsAffected: number };

export function migrate(db: Db, dirOverride?: string): AppliedMigration[] {
  const dir = dirOverride ?? defaultMigrationsDir();
  // audit-added M1: surface a clear, actionable error if migrations/ is missing.
  // This typically means the standalone build did not include the directory
  // (next.config.ts outputFileTracingIncludes) or the Dockerfile did not COPY it.
  if (!fs.existsSync(dir)) {
    throw new Error(
      `migrations directory not found at ${dir} — check Dockerfile COPY and next.config.ts outputFileTracingIncludes`,
    );
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const result: AppliedMigration[] = [];

  for (const file of files) {
    const version = parseVersion(file);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const insertVersion = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );
    const changesStmt = db.prepare('SELECT changes() AS n');
    let rowsAffected = 0;
    // better-sqlite3 transactions auto-rollback on throw — both the schema
    // changes from `db.exec(sql)` and the version insert undo as a unit.
    // 16-05 S5: capture `SELECT changes()` IMMEDIATELY after db.exec(sql) so
    // the count reflects the migration's last DML statement and is not
    // overwritten by the subsequent insertVersion.run() (which would set
    // changes()=1 unconditionally).
    const tx = db.transaction(() => {
      db.exec(sql);
      rowsAffected = (changesStmt.get() as { n: number }).n;
      insertVersion.run(version, Math.floor(Date.now() / 1000));
    });
    try {
      tx();
      result.push({ version, rowsAffected });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`migration failed: ${file} — ${cause}`);
    }
  }
  return result;
}
