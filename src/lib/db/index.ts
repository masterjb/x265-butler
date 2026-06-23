import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../logger';
import { migrate, type AppliedMigration } from './migrate';
import { makeFileRepo, type FileRepo } from './repos/file';
import { makeSettingRepo, type SettingRepo } from './repos/setting';
import { makeJobRepo, type JobRepo } from './repos/job';
import { makeTrashRepo, type TrashRepo } from './repos/trash';
import { makeStatsRepo, type StatsRepo } from './repos/stats';
import { makeBenchRunRepo, type BenchRunRepo } from './repos/bench-run';
import { makeBenchComboRepo, type BenchComboRepo } from './repos/bench-combo';
// 11-01: re-export bench types so consumers import from `@/src/lib/db` without
// depth-traversing into repos/.
export type {
  BenchRunRow,
  BenchRunCreateInput,
  BenchRunStatus,
  BenchMode,
  BenchComboRow,
  BenchComboCreateInput,
  BenchComboStatus,
  Top3Role,
  AggregatedCombo,
  AggregatedComboView,
  BenchMatrix,
  BenchMatrixNativeSweep,
  BenchMatrixVmafAnchored,
} from './schema';
export { OccConflictError } from './repos/bench-run';
// 07-01: re-export RecentActivityRow so Dashboard Server Component imports
// the type from `@/src/lib/db` without depth-traversing into repos/.
export type { RecentActivityRow } from './repos/stats';
// 07-02 A4: re-export codec/container distribution types — Dashboard Server
// Component + CodecDistributionCard import from `@/src/lib/db` without
// depth-traversing into repos/.
// 07-05: re-export new stats types for Stats page Server Component.
// 08-05: StatsRepo re-exported so Stats page Server Component + stats-client.tsx
// can import the type without depth-traversing into repos/.
export type {
  CodecBucketKey,
  ContainerBucketKey,
  CodecBucket,
  ContainerBucket,
  CodecDistribution,
  StatsTrendPointFull,
  TopSaverRow,
  EncoderPerfRow,
  StatsRepo,
} from './repos/stats';
import { makeBlocklistRepo, type BlocklistRepo } from './repos/blocklist';
import { makeUserRepo, type UserRepo } from './repos/user';
import { makeShareRepo, type ShareRepo } from './repos/share';
import { makeStorageRepo, type StorageRepo } from './repos/storage';
// 14-01: re-export share types + nested-error so consumers import from
// `@/src/lib/db` without depth-traversing into repos/.
export type { ShareRow, ShareCreateInput, ShareUpdateInput } from './schema';
export { ShareNestedPathError } from './repos/share';
// 15-01: re-export storage aggregation types for route handlers + tests.
export type {
  KpiResult,
  BucketResult,
  CodecSlice,
  ShareTableRow,
  TopFolderRow,
  TopFoldersResult,
  StorageRepo,
} from './repos/storage';

type Db = InstanceType<typeof Database>;

let _db: Db | null = null;
let _fileRepo: FileRepo | null = null;
let _settingRepo: SettingRepo | null = null;
let _jobRepo: JobRepo | null = null;
let _trashRepo: TrashRepo | null = null;
let _statsRepo: StatsRepo | null = null;
let _blocklistRepo: BlocklistRepo | null = null;
let _userRepo: UserRepo | null = null;
let _benchRunRepo: BenchRunRepo | null = null;
let _benchComboRepo: BenchComboRepo | null = null;
let _shareRepo: ShareRepo | null = null;
let _storageRepo: StorageRepo | null = null;

// 03-04 audit M2: EXPORTED so /api/stats route + Dashboard Server Component
// resolve dbPath via single source of truth (NOT a duplicated env-default).
// Behavior byte-identical to the prior private resolveDbPath() — same fall-
// through chain (DB_PATH env → /config/x265-butler.db production → cwd/data/dev.db).
export function getDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.NODE_ENV === 'production') return '/config/x265-butler.db';
  return path.join(process.cwd(), 'data', 'dev.db');
}

function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
}

// audit-added S12: SIGTERM/SIGINT → db.close() so WAL is checkpointed cleanly
// on container stop.
//
// 2026-04-27 hotfix: HMR-safe via globalThis flag. Previously `_shutdownRegistered`
// was module-local — Next.js dev hot-reload re-evaluated this module on every
// dependency edit, resetting the flag while `process` (Node-global) accumulated
// the SIGTERM/SIGINT handlers. After 5+ HMR cycles the v8 EventEmitter fired
// `MaxListenersExceededWarning: 11 SIGTERM listeners`. Lifting the flag to
// globalThis (same pattern as __x265butler_init / __x265butler_engine_events)
// keeps the registration single-shot across module re-evaluations.
//
// 02-03 audit S4: BEFORE db.close, also tear down server-init (encoder loop +
// retention sweep) so in-flight work emits final pino logs against a still-open
// DB. Order: stopEncoderLoop awaits in-flight loopOnce → clear sweep timer →
// THEN db.close. teardownServerInit dynamically imported to avoid build-time
// circular dependency between db/index.ts and server-init.ts (server-init
// imports trashRepo from this module).
function registerShutdownHandlers(db: Db): void {
  if (globalThis.__x265butler_shutdown_registered) return;
  globalThis.__x265butler_shutdown_registered = true;
  const close = async (): Promise<void> => {
    try {
      const { teardownServerInit } = await import('../server-init');
      await teardownServerInit();
    } catch {
      // process is going down — swallow; db.close still happens below
    }
    try {
      db.close();
    } catch {
      // process is going down — swallow
    }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

// 16-05 S5: structured audit-log for migrations with operator-visible data
// effect. Called exactly once per process boot, only for migrations newly
// applied on this run (re-applies cannot happen — schema_migrations gates
// at the runner level). Centralized here so the migration SQL files stay
// pure data and the runner stays agnostic to per-migration messaging.
// Exported for direct test invocation (synthetic AppliedMigration array).
export function emitMigrationAuditLogs(appliedMigrations: AppliedMigration[]): void {
  for (const m of appliedMigrations) {
    if (m.version === 28) {
      logger.info(
        {
          migration: '0028',
          action: 'migrated_default_output_suffix',
          from: '.x265.mkv',
          to: '-x265',
          rowsAffected: m.rowsAffected,
        },
        '16-05: default output_suffix migrated',
      );
    }
  }
}

export function getDb(): Db {
  if (_db) return _db;
  const dbPath = getDbPath();
  // audit-added M7: ensure the parent directory exists before opening.
  // /config (unRAID mount) or ./data (dev) may not yet contain anything.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  applyPragmas(db);
  const appliedMigrations = migrate(db);
  emitMigrationAuditLogs(appliedMigrations);
  registerShutdownHandlers(db);
  _db = db;
  return db;
}

export function fileRepo(): FileRepo {
  if (!_fileRepo) _fileRepo = makeFileRepo(getDb());
  return _fileRepo;
}

export function settingRepo(): SettingRepo {
  if (!_settingRepo) _settingRepo = makeSettingRepo(getDb());
  return _settingRepo;
}

// 02-01: jobRepo wires the OCC-aware fileRepo.setStatus via DI so the S2
// transactional `enqueue` helper can flip file.status atomically with the
// job INSERT. Lazy lookup avoids a circular module init order.
//
// 05-09 audit M2: bulkSetFileStatusToPending wires the bulk file→pending
// helper into the transactional cancelJobsAndPendFilesTx path.
export function jobRepo(): JobRepo {
  if (!_jobRepo) {
    _jobRepo = makeJobRepo(getDb(), {
      setFileStatus: (id, status, expectedVersion) =>
        fileRepo().setStatus(id, status, expectedVersion),
      bulkSetFileStatusToPending: (ids, expectedStates) =>
        fileRepo().bulkSetStatusToPendingByIds(ids, expectedStates),
    });
  }
  return _jobRepo;
}

export function trashRepo(): TrashRepo {
  if (!_trashRepo) _trashRepo = makeTrashRepo(getDb());
  return _trashRepo;
}

// 03-04: aggregation-only repo for the Dashboard. Read-only — no DI needed
// (audit D-statsrepo-di simpler-by-design intent).
export function statsRepo(): StatsRepo {
  if (!_statsRepo) _statsRepo = makeStatsRepo(getDb());
  return _statsRepo;
}

// 04-02: blocklist repo for skip-pipeline step 7 + Library UI. Single instance
// per process; mirrors jobRepo/trashRepo singleton pattern.
export function blocklistRepo(): BlocklistRepo {
  if (!_blocklistRepo) _blocklistRepo = makeBlocklistRepo(getDb());
  return _blocklistRepo;
}

// 05-01: user repo for single-user optional auth.
export function userRepo(): UserRepo {
  if (!_userRepo) _userRepo = makeUserRepo(getDb());
  return _userRepo;
}

// 14-01: shareRepo singleton — multi-share foundation. Mirror userRepo pattern.
export function shareRepo(): ShareRepo {
  if (!_shareRepo) _shareRepo = makeShareRepo(getDb());
  return _shareRepo;
}

// 15-01: storage aggregation repo (Storage-Analyzer backend). DI on shareRepo
// for share-root path resolution in top-folders aggregation.
export function storageRepo(): StorageRepo {
  if (!_storageRepo) _storageRepo = makeStorageRepo(getDb(), { shareRepo: shareRepo() });
  return _storageRepo;
}

// 11-01: bench repos — HMR-safe singletons per existing pattern.
export function benchRunRepo(): BenchRunRepo {
  if (!_benchRunRepo) _benchRunRepo = makeBenchRunRepo(getDb());
  return _benchRunRepo;
}

export function benchComboRepo(): BenchComboRepo {
  if (!_benchComboRepo) _benchComboRepo = makeBenchComboRepo(getDb());
  return _benchComboRepo;
}

// Test-only helpers — never imported from production code paths.
export function __forTests_setDb(db: Db): void {
  _db = db;
  _fileRepo = null;
  _settingRepo = null;
  _jobRepo = null;
  _trashRepo = null;
  _statsRepo = null;
  _blocklistRepo = null;
  _userRepo = null;
  _benchRunRepo = null;
  _benchComboRepo = null;
  _shareRepo = null;
  _storageRepo = null;
}

export function __forTests_resetDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore
    }
  }
  _db = null;
  _fileRepo = null;
  _settingRepo = null;
  _jobRepo = null;
  _trashRepo = null;
  _statsRepo = null;
  _blocklistRepo = null;
  _userRepo = null;
  _benchRunRepo = null;
  _benchComboRepo = null;
  _shareRepo = null;
  _storageRepo = null;
}
