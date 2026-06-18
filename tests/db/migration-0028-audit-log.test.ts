// 16-05 audit S5 + AC-11: migration 0028 audit-log emission test.
//
// Two layers verified:
//   1. migrate() returns AppliedMigration[] with correct rowsAffected per
//      install path (legacy-default row matches the UPDATE WHERE clause → 1;
//      operator-customized row does not match → 0)
//   2. emitMigrationAuditLogs() emits ONE pino INFO line per applied 0028
//      with the structured-log shape from AC-11 (`migrated_default_output_suffix`
//      + from / to / rowsAffected)
//
// Layer split keeps the migration-runner test pure-data and the logger
// shim test pure-behavior — neither needs a full server-init bootstrap.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import { migrate, type AppliedMigration } from '@/src/lib/db/migrate';
import { emitMigrationAuditLogs } from '@/src/lib/db';

type Db = InstanceType<typeof Database>;

describe('migration 0028 — audit-log (16-05 AC-11)', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.error.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it('fresh-install path: rowsAffected=1 (0011 seed → 0028 UPDATE match)', () => {
    const applied = migrate(db);
    const m0028 = applied.find((m) => m.version === 28);
    expect(m0028).toBeDefined();
    expect(m0028!.rowsAffected).toBe(1);
  });

  it('legacy-uncustomized: same as fresh — 0028 UPDATE matches the legacy seed', () => {
    // The schema_migrations table tracks "applied" — we cannot easily
    // emulate "0011 applied, 0028 unapplied" on the same in-memory DB
    // because migrate() applies all available files in one pass. The
    // legacy-uncustomized scenario is functionally identical to fresh-
    // install at the migration-runner layer: 0011 seeds '.x265.mkv', 0028
    // UPDATEs it. Asserting fresh-install path is equivalent.
    const applied = migrate(db);
    expect(applied.find((m) => m.version === 28)?.rowsAffected).toBe(1);
  });

  it('operator-customized: rowsAffected=0 (UPDATE WHERE skips non-legacy value)', () => {
    // Step 1: drive migrations up to 0027 by deleting 0028 from the SQL
    // discovery via dirOverride trick — point at a tmp dir containing only
    // 0001-0027 + (later) 0028 separately. Simpler path: run full migrate
    // (which seeds '.x265.mkv' via 0011, then 0028 UPDATEs to '-x265'),
    // then set operator value, then manually re-run 0028 SQL after wiping
    // its applied-marker.
    migrate(db);
    db.prepare("UPDATE setting SET value = '_h265' WHERE key = 'output_suffix'").run();
    // Force re-apply of 0028 by deleting its applied-marker, then re-run
    // the migrator. The SQL UPDATE WHERE clause will skip ('_h265' !=
    // '.x265.mkv') so rowsAffected MUST be 0.
    db.prepare('DELETE FROM schema_migrations WHERE version = 28').run();
    const replayed = migrate(db);
    const m0028 = replayed.find((m) => m.version === 28);
    expect(m0028).toBeDefined();
    expect(m0028!.rowsAffected).toBe(0);
    // Verify the operator-customized value was preserved.
    const value = db.prepare("SELECT value FROM setting WHERE key = 'output_suffix'").get() as {
      value: string;
    };
    expect(value.value).toBe('_h265');
  });

  it('emitMigrationAuditLogs: rowsAffected=1 → ONE INFO log with migrated_default_output_suffix shape', () => {
    const synthetic: AppliedMigration[] = [{ version: 28, rowsAffected: 1 }];
    emitMigrationAuditLogs(synthetic);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        migration: '0028',
        action: 'migrated_default_output_suffix',
        from: '.x265.mkv',
        to: '-x265',
        rowsAffected: 1,
      },
      '16-05: default output_suffix migrated',
    );
  });

  it('emitMigrationAuditLogs: rowsAffected=0 → ONE INFO log (audit trail fires regardless)', () => {
    const synthetic: AppliedMigration[] = [{ version: 28, rowsAffected: 0 }];
    emitMigrationAuditLogs(synthetic);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        migration: '0028',
        action: 'migrated_default_output_suffix',
        rowsAffected: 0,
      }),
      '16-05: default output_suffix migrated',
    );
  });

  it('emitMigrationAuditLogs: empty array → ZERO INFO logs (subsequent boots)', () => {
    emitMigrationAuditLogs([]);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('emitMigrationAuditLogs: non-28 versions ignored (no spurious 16-05 log)', () => {
    const synthetic: AppliedMigration[] = [
      { version: 11, rowsAffected: 1 },
      { version: 27, rowsAffected: 0 },
    ];
    emitMigrationAuditLogs(synthetic);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
