// 47-01 T1 — BenchOrchestrator.purgeRun(): the single policy seam for bench-run purge.
// Covers AC-1 (cascade + files untouched + library-unblock), AC-2 (active-run guard),
// AC-3 (active-pass2 guard + guard precedence), AC-9 (map hygiene + audit line),
// AC-10 (composes into an outer transaction — rollback really rolls back).
//
// Harness note: unlike the sibling orchestrator tests this one runs against a REAL
// in-memory better-sqlite3 DB with foreign_keys=ON. The CASCADE, the SAVEPOINT/rollback
// semantics and the library-unblock guard are exactly the things a repo mock
// cannot prove.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// The orchestrator module imports these at load time; keep them inert.
vi.mock('@/src/lib/bench/vmaf', () => ({
  encodeForBench: vi.fn(),
  computeVmaf: vi.fn(),
}));
vi.mock('@/src/lib/bench/sample-extractor', () => ({
  extractSamples: vi.fn(),
  SampleExtractorError: class SampleExtractorError extends Error {},
}));
vi.mock('@/src/lib/encode/ffmpeg', () => ({
  runEncode: vi.fn(),
  buildArgs: vi.fn(() => []),
}));
// Prevents the real singleton DB from being opened on module load. purgeRun never
// touches these — the orchestrator under test is constructed with real repos below.
vi.mock('@/src/lib/db', () => ({
  benchRunRepo: vi.fn(),
  benchComboRepo: vi.fn(),
  fileRepo: () => ({ getById: vi.fn() }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));
vi.mock('node:fs/promises');

import { migrate } from '@/src/lib/db/migrate';
import { makeBenchRunRepo } from '@/src/lib/db/repos/bench-run';
import { makeBenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import { makeFileRepo } from '@/src/lib/db/repos/file';
import { BenchOrchestrator } from '@/src/lib/bench/orchestrator';
import { logger } from '@/src/lib/logger';

type Db = InstanceType<typeof Database>;

type PrivateOrchestrator = {
  cancelledRuns: Set<number>;
  progressThrottle: Map<number, number>;
  inFlightControllers: Map<number, AbortController>;
  isPass2Running: boolean;
  pass2InFlight: { runId: number; comboId: number } | null;
};

const MATRIX = { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] };

let db: Db;
let orch: BenchOrchestrator;
let infoSpy: ReturnType<typeof vi.spyOn>;

function priv(): PrivateOrchestrator {
  return orch as unknown as PrivateOrchestrator;
}

function seedFile(path: string, hash: string): number {
  const r = db
    .prepare(
      'INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES (?, 1000, 1, ?, 1)',
    )
    .run(path, hash);
  return r.lastInsertRowid as number;
}

function seedCombos(runId: number, fileId: number, n: number): void {
  const insert = db.prepare(
    `INSERT INTO bench_combo
       (run_id, file_id, encoder, preset, native_quality_param, native_quality_value,
        vmaf_target, sample_idx, status, is_pareto, created_at)
     VALUES (?, ?, 'libx265', 'medium', '-crf', 23, NULL, ?, 'pending', 0, 1)`,
  );
  for (let i = 0; i < n; i++) insert.run(runId, fileId, i);
}

function comboCount(runId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM bench_combo WHERE run_id=?').get(runId) as {
      c: number;
    }
  ).c;
}

/** Creates a run and drives it into a terminal status via the real repo state machine. */
function makeRun(
  fileIds: number[],
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled' = 'complete',
): number {
  const repo = makeBenchRunRepo(db);
  const id = repo.create({ mode: 'native-sweep', fileIds, matrix: MATRIX });
  if (status === 'pending') return id;
  repo.markRunning(id, 1);
  if (status === 'running') return id;
  if (status === 'complete') repo.markComplete(id, 2);
  if (status === 'failed') repo.markFailed(id, 'boom', 2);
  if (status === 'cancelled') repo.markCancelled(id, 2);
  return id;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // ASSERT the pragma took — a silently-off foreign_keys makes every CASCADE
  // assertion below pass vacuously (tests/db/trash-repo.test.ts:15-17 pattern).
  const fkOn = db.pragma('foreign_keys', { simple: true });
  if (fkOn !== 1) throw new Error(`expected foreign_keys=1, got ${String(fkOn)}`);
  migrate(db);
  orch = new BenchOrchestrator(makeBenchRunRepo(db), makeBenchComboRepo(db));
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
});

afterEach(() => {
  infoSpy.mockRestore();
  db.close();
});

describe('BenchOrchestrator.purgeRun — happy path (AC-1)', () => {
  it('deletes the run, cascades its combos, returns combosDeleted, leaves file rows intact', () => {
    const fileId = seedFile('/media/a.mkv', 'a'.repeat(64));
    const runId = makeRun([fileId], 'complete');
    seedCombos(runId, fileId, 5);

    const result = orch.purgeRun(runId);

    expect(result).toEqual({ combosDeleted: 5 });
    expect(makeBenchRunRepo(db).findById(runId)).toBeNull();
    expect(comboCount(runId)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM file').get() as { c: number }).c).toBe(1);
  });

  it.each(['complete', 'failed', 'cancelled'] as const)('purges a %s run', (status) => {
    const fileId = seedFile(`/media/${status}.mkv`, status.padEnd(64, 'x'));
    const runId = makeRun([fileId], status);
    seedCombos(runId, fileId, 2);

    expect(orch.purgeRun(runId)).toEqual({ combosDeleted: 2 });
    expect(makeBenchRunRepo(db).findById(runId)).toBeNull();
  });

  it('purges a run that owns zero combos → combosDeleted 0', () => {
    const runId = makeRun([], 'complete');
    expect(orch.purgeRun(runId)).toEqual({ combosDeleted: 0 });
  });

  it('does not touch sibling runs or their combos', () => {
    const fileId = seedFile('/media/a.mkv', 'a'.repeat(64));
    const doomed = makeRun([fileId], 'complete');
    const keeper = makeRun([fileId], 'complete');
    seedCombos(doomed, fileId, 3);
    seedCombos(keeper, fileId, 4);

    orch.purgeRun(doomed);

    expect(comboCount(keeper)).toBe(4);
    expect(makeBenchRunRepo(db).findById(keeper)).not.toBeNull();
  });

  // AC-1 (audit S6): the reported operator bug — the library entry becomes deletable.
  // 47-03: the guard now only counts ACTIVE runs, so a 'failed' run stops blocking
  // regardless of the purge. What the purge still owns is severing the bench_combo
  // references themselves — asserted via countBenchRefs. purgeRun refuses
  // pending/running runs ('active_run'), so a terminal run is the only shape here.
  it('releases the bench references so no combo row points at the file any more', () => {
    const fileId = seedFile('/media/stuck.mkv', 'f'.repeat(64));
    const runId = makeRun([fileId], 'failed');
    seedCombos(runId, fileId, 3);
    const files = makeFileRepo(db);

    expect(files.countBenchRefs(fileId)).toBe(3);
    // A terminal run never blocks the library delete post-47-03.
    expect(files.isReferencedByActiveBench(fileId)).toBe(false);

    orch.purgeRun(runId);

    expect(files.countBenchRefs(fileId)).toBe(0);
    expect(files.isReferencedByActiveBench(fileId)).toBe(false);
    // AND the file row itself survived the purge (delete-eligible, not deleted).
    expect(files.getById(fileId)).not.toBeUndefined();
  });
});

describe('BenchOrchestrator.purgeRun — guards (AC-2 / AC-3 / AC-4)', () => {
  it('unknown runId → throws code run_not_found', () => {
    expect(() => orch.purgeRun(999_999)).toThrow();
    try {
      orch.purgeRun(999_999);
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe('run_not_found');
    }
  });

  it.each(['pending', 'running'] as const)(
    '%s run → throws code active_run, run + combos untouched',
    (status) => {
      const fileId = seedFile(`/media/${status}.mkv`, status.padEnd(64, 'y'));
      const runId = makeRun([fileId], status);
      seedCombos(runId, fileId, 3);

      try {
        orch.purgeRun(runId);
        throw new Error('expected purgeRun to throw');
      } catch (e) {
        expect((e as Error & { code?: string }).code).toBe('active_run');
        expect((e as Error & { currentStatus?: string }).currentStatus).toBe(status);
      }
      expect(makeBenchRunRepo(db).findById(runId)).not.toBeNull();
      expect(comboCount(runId)).toBe(3);
    },
  );

  it('complete run with an in-flight pass-2 → throws code active_pass2, nothing deleted', () => {
    const fileId = seedFile('/media/p2.mkv', 'p'.repeat(64));
    const runId = makeRun([fileId], 'complete');
    seedCombos(runId, fileId, 2);
    priv().isPass2Running = true;
    priv().pass2InFlight = { runId, comboId: 42 };

    try {
      orch.purgeRun(runId);
      throw new Error('expected purgeRun to throw');
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe('active_pass2');
    }
    expect(makeBenchRunRepo(db).findById(runId)).not.toBeNull();
    expect(comboCount(runId)).toBe(2);
  });

  it('pass-2 in flight for a DIFFERENT run does not block this purge', () => {
    const fileId = seedFile('/media/p2b.mkv', 'q'.repeat(64));
    const runId = makeRun([fileId], 'complete');
    const otherRunId = makeRun([fileId], 'complete');
    priv().isPass2Running = true;
    priv().pass2InFlight = { runId: otherRunId, comboId: 7 };

    expect(orch.purgeRun(runId)).toEqual({ combosDeleted: 0 });
  });

  // AC-3 (audit S4): a run can satisfy BOTH guards — active-run must win.
  it('running run that is ALSO the pass2InFlight target → active_run wins over active_pass2', () => {
    const fileId = seedFile('/media/both.mkv', 'b'.repeat(64));
    const runId = makeRun([fileId], 'running');
    priv().isPass2Running = true;
    priv().pass2InFlight = { runId, comboId: 9 };

    try {
      orch.purgeRun(runId);
      throw new Error('expected purgeRun to throw');
    } catch (e) {
      expect((e as Error & { code?: string }).code).toBe('active_run');
    }
  });
});

describe('BenchOrchestrator.purgeRun — in-memory hygiene + audit line (AC-9)', () => {
  it('clears cancelledRuns / progressThrottle / inFlightControllers entries for the run', () => {
    const fileId = seedFile('/media/h.mkv', 'h'.repeat(64));
    const runId = makeRun([fileId], 'cancelled');
    const keeper = makeRun([fileId], 'complete');

    priv().cancelledRuns.add(runId);
    priv().cancelledRuns.add(keeper);
    priv().progressThrottle.set(runId, 1234);
    priv().progressThrottle.set(keeper, 5678);
    priv().inFlightControllers.set(runId, new AbortController());
    priv().inFlightControllers.set(keeper, new AbortController());

    orch.purgeRun(runId);

    expect(priv().cancelledRuns.has(runId)).toBe(false);
    expect(priv().progressThrottle.has(runId)).toBe(false);
    expect(priv().inFlightControllers.has(runId)).toBe(false);
    // scoped to the purged run only
    expect(priv().cancelledRuns.has(keeper)).toBe(true);
    expect(priv().progressThrottle.has(keeper)).toBe(true);
    expect(priv().inFlightControllers.has(keeper)).toBe(true);
  });

  // AC-9 (audit M5): after the purge this line is the ONLY surviving evidence of what
  // was destroyed — assert field-by-field, not just { audit, runId }.
  it('emits bench_run_purged with previousStatus / mode / createdAt / fileIds populated', () => {
    const fileA = seedFile('/media/m5a.mkv', 'm'.repeat(64));
    const fileB = seedFile('/media/m5b.mkv', 'n'.repeat(64));
    const runId = makeRun([fileA, fileB], 'failed');
    seedCombos(runId, fileA, 2);
    const createdAt = makeBenchRunRepo(db).findById(runId)!.created_at;

    orch.purgeRun(runId);

    expect(infoSpy).toHaveBeenCalledWith(
      {
        audit: 'bench_run_purged',
        runId,
        combosDeleted: 2,
        previousStatus: 'failed',
        mode: 'native-sweep',
        createdAt,
        fileIds: [fileA, fileB],
      },
      'bench run purged',
    );
    const payload = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    for (const key of ['previousStatus', 'mode', 'createdAt', 'fileIds'] as const) {
      expect(payload[key]).toBeDefined();
    }
  });

  it('emits no audit line when a guard rejects the purge', () => {
    const fileId = seedFile('/media/noaudit.mkv', 'z'.repeat(64));
    const runId = makeRun([fileId], 'running');
    expect(() => orch.purgeRun(runId)).toThrow();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

// AC-10 (audit M6): the 200-always partial-success envelope of the bulk route rests
// on ROLLBACK TO actually undoing a purge. That holds only while the orchestrator's
// repos sit on the SAME better-sqlite3 connection the route's transaction runs on.
// This is the executable pin for that invariant.
describe('BenchOrchestrator.purgeRun — transaction composition (AC-10)', () => {
  it('an outer transaction that throws leaves the run AND its combos intact', () => {
    const fileId = seedFile('/media/tx.mkv', 't'.repeat(64));
    const runId = makeRun([fileId], 'complete');
    seedCombos(runId, fileId, 4);

    const tx = db.transaction(() => {
      orch.purgeRun(runId);
      throw new Error('outer-tx-boom');
    });

    expect(() => tx()).toThrow('outer-tx-boom');
    expect(makeBenchRunRepo(db).findById(runId)).not.toBeNull();
    expect(comboCount(runId)).toBe(4);
  });

  it('a per-id SAVEPOINT rollback undoes exactly one purge and keeps the sibling committed', () => {
    const fileId = seedFile('/media/sp.mkv', 's'.repeat(64));
    const doomed = makeRun([fileId], 'complete');
    const rolledBack = makeRun([fileId], 'complete');
    seedCombos(doomed, fileId, 2);
    seedCombos(rolledBack, fileId, 3);

    const tx = db.transaction(() => {
      db.prepare('SAVEPOINT sp_a').run();
      orch.purgeRun(doomed);
      db.prepare('RELEASE sp_a').run();

      db.prepare('SAVEPOINT sp_b').run();
      orch.purgeRun(rolledBack);
      db.prepare('ROLLBACK TO sp_b').run();
      db.prepare('RELEASE sp_b').run();
    });
    tx();

    const repo = makeBenchRunRepo(db);
    expect(repo.findById(doomed)).toBeNull();
    expect(comboCount(doomed)).toBe(0);
    expect(repo.findById(rolledBack)).not.toBeNull();
    expect(comboCount(rolledBack)).toBe(3);
  });

  // purgeRun MUST stay synchronous (audit M6b): the TOCTOU defense AND the
  // precondition for composing inside the bulk route's SAVEPOINT.
  it('returns a plain object, never a Promise (synchronicity contract)', () => {
    const runId = makeRun([], 'complete');
    const result: unknown = orch.purgeRun(runId);
    expect(result).not.toBeInstanceOf(Promise);
    expect(orch.purgeRun).not.toHaveProperty('constructor.name', 'AsyncFunction');
    expect(Object.getPrototypeOf(orch.purgeRun).constructor.name).toBe('Function');
  });
});
