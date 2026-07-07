#!/usr/bin/env node
/**
 * 05-01 audit S9: forgot-password operator recovery script.
 *
 * Run from inside the running container:
 *   docker exec -it x265-butler sh
 *   node scripts/auth-reset.ts
 *
 * Effect:
 *   - DELETE all rows from `user`
 *   - setting auth_enabled='false'
 *   - setting auth_setup_completed='false'
 *   - setting session_secret=''
 *
 * After running, the operator can either re-run /api/auth/setup or simply
 * leave auth disabled.
 *
 * Documented in 05-05 README polish (operator runbook section).
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import process from 'node:process';

function resolveDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.NODE_ENV === 'production') return '/config/x265-butler.db';
  return path.join(process.cwd(), 'data', 'dev.db');
}

function main(): void {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    const tx = db.transaction(() => {
      db.prepare("UPDATE setting SET value='false' WHERE key='auth_enabled'").run();
      db.prepare("UPDATE setting SET value='false' WHERE key='auth_setup_completed'").run();
      db.prepare("UPDATE setting SET value='' WHERE key='session_secret'").run();
      db.prepare('DELETE FROM user').run();
    });
    tx();

    // Mirror pino info shape used by /api/auth/* handlers for log correlation.
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        time: Math.floor(Date.now() / 1000),
        event: 'auth_reset_via_script',
        dbPath,
      }) + '\n',
    );
    process.stdout.write(
      'auth state reset; restart container or hit /api/settings to refresh runtime cache\n',
    );
  } finally {
    db.close();
  }
}

main();
