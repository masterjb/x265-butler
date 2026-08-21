/*
 * 49-05 Task 1 — the crf_qsv seed change must NOT touch existing installations
 * (AC-8, AC-8b, AC-8c).
 *
 * Why two cases and not the obvious one (audit MH-5): "apply the migrations,
 * then apply them AGAIN" proves nothing. migrate.ts:63 skips every version
 * already present in schema_migrations, so the second pass is a no-op for ALL
 * migrations — that test would stay green even if 0005 carried an
 * `UPDATE setting SET value='26'`. It would test the runner's idempotence, not
 * the effect of the edited seed.
 *
 * The two branches where the FILE CONTENT actually decides:
 *   (a) AC-8b  upgrade — a DB seeded with the OLD 0005 content ('22') plus its
 *              schema_migrations row, then migrated against the NEW directory.
 *              0005 must be skipped, the stored 22 must survive.
 *   (b) AC-8c  disaster recovery — the same DB with the version=5 row MISSING,
 *              which is exactly the case 0005's own comment names as the reason
 *              for INSERT OR IGNORE. Here the NEW seed ('26') genuinely re-runs,
 *              and only INSERT OR IGNORE against the `setting.key` PRIMARY KEY
 *              (migrations/0001_initial.sql:27) keeps the operator's 22.
 *
 * Pattern mirrors tests/db/migration-0029-bench-combo-nullable.test.ts: copy the
 * migrations into a tmpdir, mutate the copy, migrate through it, then run
 * migrate() against the REAL migrations/ dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';
import { ENCODER_IDS } from '@/src/lib/encode/profiles';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATION_0005 = '0005_encoder_settings.sql';

/** The pre-49-05 0005 body, verbatim in the part that matters. */
const OLD_0005 = `INSERT OR IGNORE INTO setting (key, value) VALUES
  ('encoder',       'auto'),
  ('concurrency',   'auto'),
  ('crf_libx265',   '23'),
  ('crf_nvenc',     '23'),
  ('crf_qsv',       '22'),
  ('crf_vaapi',     '22');
`;

let tmpDir: string;
let db: Db;

function readCrf(d: Db): Record<string, string | undefined> {
  const rows = d.prepare("SELECT key, value FROM setting WHERE key LIKE 'crf_%'").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** A DB in the state a pre-49-05 installation is in: seeded from the OLD 0005. */
function seedLegacyInstallation(): Db {
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(tmpDir, f));
  }
  fs.writeFileSync(path.join(tmpDir, MIGRATION_0005), OLD_0005, 'utf8');
  const d = new Database(':memory:');
  migrate(d, tmpDir);
  return d;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-crf-seed-'));
  db = seedLegacyInstallation();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('49-05: the crf_qsv seed change spares existing installations', () => {
  it('the constructed pre-state really is the old one', () => {
    expect(readCrf(db).crf_qsv).toBe('22');
    const v = db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get();
    expect(v).toBeDefined();
  });

  // AC-8 / AC-8b
  it('upgrade: 0005 is skipped, the stored 22 survives', () => {
    const applied = migrate(db, MIGRATIONS_DIR);
    expect(applied.map((a) => a.version)).not.toContain(5);
    expect(readCrf(db).crf_qsv).toBe('22');
  });

  // AC-8c — the ONE branch where the edited file body actually executes again.
  it('disaster recovery: 0005 re-runs with the NEW seed, INSERT OR IGNORE keeps 22', () => {
    db.prepare('DELETE FROM schema_migrations WHERE version = 5').run();
    const applied = migrate(db, MIGRATIONS_DIR);
    expect(applied.map((a) => a.version)).toContain(5);

    const after = readCrf(db);
    expect(after.crf_qsv).toBe('22');
    // Not just qsv — no crf_* row of an existing installation may move.
    for (const enc of ENCODER_IDS) {
      expect(after[`crf_${enc}`]).toBe(enc === 'libx265' || enc === 'nvenc' ? '23' : '22');
    }
  });

  // The mirror case: a genuinely FRESH install must receive the new number.
  it('fresh install receives the new qsv seed (26)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh, MIGRATIONS_DIR);
    expect(readCrf(fresh).crf_qsv).toBe('26');
    expect(readCrf(fresh).crf_vaapi).toBe('22');
    fresh.close();
  });
});
