/*
 * Plan 52-05 AC-2 (user-added, audit MH-1): a run in which nothing was measured
 * must end as `failed` and name the cause.
 *
 * Befund 2026-09-29 (unRAID-dev, run #3): 63/63 NVENC combos failed with
 * "Driver does not support the required nvenc API version. Required: 13.1
 * Found: 13.0", the run still ended `complete`, the page only said "Kein
 * Kandidat".
 *
 * Real DB (full migration chain) + real bench repos + the REAL encodeForBench.
 * Only the process boundary is faked: `spawn` replays the stderr captured on
 * unRAID for encode calls; sample extraction and VMAF are stubbed because they
 * are not what this test is about.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('node:child_process');
vi.mock('node:fs/promises');
vi.mock('@/src/lib/bench/vmaf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/bench/vmaf')>()),
  computeVmaf: vi.fn(async () => ({ vmafMean: 94.2 })),
}));
vi.mock('@/src/lib/bench/sample-extractor', () => ({
  extractSamples: vi.fn(async (_path: string, opts: { count: number }) =>
    Array.from({ length: opts.count }, (_, i) => ({ sampleIdx: i, path: `/scratch/s-${i}.mkv` })),
  ),
  SampleExtractorError: class SampleExtractorError extends Error {},
}));
vi.mock('@/src/lib/encode/ffmpeg', () => ({ runEncode: vi.fn(), buildArgs: vi.fn(() => []) }));

let db: InstanceType<typeof Database>;
vi.mock('@/src/lib/db', async () => {
  const { makeFileRepo } = await import('@/src/lib/db/repos/file');
  return {
    fileRepo: () => makeFileRepo(db),
    shareRepo: () => ({ listAll: () => [] }),
    benchRunRepo: vi.fn(),
    benchComboRepo: vi.fn(),
    default: {},
  };
});

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { migrate } from '@/src/lib/db/migrate';
import { makeBenchRunRepo } from '@/src/lib/db/repos/bench-run';
import { makeBenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import { BenchOrchestrator } from '@/src/lib/bench/orchestrator';
import { engineEvents } from '@/src/lib/encode/events';

const befundStderr = readFileSync(
  path.join(process.cwd(), 'tests/fixtures/bench/nvenc-api-too-new.stderr.txt'),
  'utf8',
);

function fakeChild(exitCode: number, stderrText: string): ChildProcess {
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr });
  setImmediate(() => {
    if (stderrText) stderr.emit('data', Buffer.from(stderrText));
    child.emit('close', exitCode);
  });
  return child as unknown as ChildProcess;
}

function seedFile(): number {
  return Number(
    db
      .prepare(
        "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/media/VID.mp4', 652271508, 1, 'h', 1)",
      )
      .run().lastInsertRowid,
  );
}

function runRow(runId: number): { status: string; error_reason: string | null } {
  return db.prepare('SELECT status, error_reason FROM bench_run WHERE id = ?').get(runId) as {
    status: string;
    error_reason: string | null;
  };
}

let emitSpy: MockInstance<typeof engineEvents.emit>;
let orch: BenchOrchestrator;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  orch = new BenchOrchestrator(makeBenchRunRepo(db), makeBenchComboRepo(db));
  emitSpy = vi.spyOn(engineEvents, 'emit');
  vi.mocked(fs.stat).mockResolvedValue({ size: 1000 } as import('node:fs').Stats);
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.unlink).mockResolvedValue(undefined);
  vi.mocked(fs.rm).mockResolvedValue(undefined);
});

afterEach(() => {
  emitSpy.mockRestore();
  vi.mocked(spawn).mockReset();
  db.close();
});

async function runNvencBench(): Promise<number> {
  const fileId = seedFile();
  const { runId } = await orch.enqueueRun({
    mode: 'native-sweep',
    fileIds: [fileId],
    matrix: { encoders: ['hevc_nvenc'], presets: ['p5'], nativeValues: [20, 25] },
    sampleCount: 1,
  } as never);
  await orch.executeNextPending();
  return runId;
}

describe('bench run with every combo failing (52-05 AC-2)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockImplementation(() => fakeChild(218, befundStderr));
  });

  it('test_run_when_all_combos_fail_then_status_failed', async () => {
    const runId = await runNvencBench();
    expect(runRow(runId).status).toBe('failed');
  });

  it('test_run_when_all_combos_fail_then_reason_counts_combos', async () => {
    const runId = await runNvencBench();
    expect(runRow(runId).error_reason).toMatch(/^all_combos_failed:2\|/);
  });

  it('test_run_when_all_combos_fail_then_reason_names_nvenc_api_cause', async () => {
    const runId = await runNvencBench();
    expect(runRow(runId).error_reason).toContain('Required: 13.1 Found: 13.0');
  });

  it('test_run_when_all_combos_fail_then_emits_bench_failed', async () => {
    const runId = await runNvencBench();
    const failed = emitSpy.mock.calls
      .map((c) => c[0] as { type: string; runId?: number })
      .filter((e) => e.type === 'bench.failed');
    expect(failed.map((e) => e.runId)).toEqual([runId]);
  });

  it('test_run_when_all_combos_fail_then_no_bench_completed', async () => {
    await runNvencBench();
    const types = emitSpy.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('bench.completed');
  });
});

describe('bench run with at least one measured combo (52-05 AC-2)', () => {
  it('test_run_when_one_combo_succeeds_then_status_complete', async () => {
    let call = 0;
    vi.mocked(spawn).mockImplementation(() =>
      call++ === 0 ? fakeChild(0, '') : fakeChild(218, befundStderr),
    );
    const runId = await runNvencBench();
    expect(runRow(runId).status).toBe('complete');
  });
});
