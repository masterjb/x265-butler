// 05-03 T1.D: log retention sweep tests.
// Phase 5 Plan 05-03 — AC-9 + audit M2 (skip active jobs).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sweepJobLogs } from '@/src/lib/log/sweep';
import type { JobRepo } from '@/src/lib/db/repos/job';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-sweep-test-'));
  await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeJobRepoMock(activeJobIds: number[]): JobRepo {
  return {
    findById: vi.fn((id: number) =>
      activeJobIds.includes(id)
        ? ({ id, status: 'encoding' } as ReturnType<JobRepo['findById']>)
        : undefined,
    ),
  } as unknown as JobRepo;
}

async function makeLogFile(jobId: string, content: string, mtimeOffsetMs: number): Promise<string> {
  const filePath = path.join(tmpDir, 'logs', `${jobId}.log`);
  await fs.writeFile(filePath, content);
  const newMtime = new Date(Date.now() - mtimeOffsetMs);
  await fs.utimes(filePath, newMtime, newMtime);
  return filePath;
}

describe('sweepJobLogs — age-based eviction', () => {
  it('deletes files older than retentionDays', async () => {
    await makeLogFile('1', 'old', 31 * 24 * 3600 * 1000); // 31 days old
    await makeLogFile('2', 'fresh', 1 * 3600 * 1000); // 1 hour old

    const result = await sweepJobLogs({
      cachePoolPath: tmpDir,
      retentionDays: 30,
      jobRepo: makeJobRepoMock([]),
    });
    expect(result.deletedCount).toBe(1);
    const remaining = await fs.readdir(path.join(tmpDir, 'logs'));
    expect(remaining).toContain('2.log');
    expect(remaining).not.toContain('1.log');
  });

  it('keeps files newer than retentionDays', async () => {
    await makeLogFile('10', 'fresh', 1 * 3600 * 1000);
    const result = await sweepJobLogs({
      cachePoolPath: tmpDir,
      retentionDays: 30,
      jobRepo: makeJobRepoMock([]),
    });
    expect(result.deletedCount).toBe(0);
  });

  it('handles empty logs directory gracefully', async () => {
    const result = await sweepJobLogs({
      cachePoolPath: tmpDir,
      retentionDays: 30,
      jobRepo: makeJobRepoMock([]),
    });
    expect(result.deletedCount).toBe(0);
  });

  it('handles missing logs directory gracefully', async () => {
    const result = await sweepJobLogs({
      cachePoolPath: '/nonexistent/path',
      retentionDays: 30,
      jobRepo: makeJobRepoMock([]),
    });
    expect(result.deletedCount).toBe(0);
  });
});

describe('sweepJobLogs — audit M2 active-job skip', () => {
  it('skips files for jobs with status=encoding even when stale', async () => {
    await makeLogFile('100', 'active-stale', 31 * 24 * 3600 * 1000);
    await makeLogFile('101', 'inactive-stale-1', 31 * 24 * 3600 * 1000);
    await makeLogFile('102', 'inactive-stale-2', 31 * 24 * 3600 * 1000);

    const result = await sweepJobLogs({
      cachePoolPath: tmpDir,
      retentionDays: 30,
      jobRepo: makeJobRepoMock([100]),
    });
    expect(result.deletedCount).toBe(2);
    expect(result.skippedActive).toBe(1);
    const remaining = await fs.readdir(path.join(tmpDir, 'logs'));
    expect(remaining).toContain('100.log');
    expect(remaining).not.toContain('101.log');
    expect(remaining).not.toContain('102.log');
  });
});

describe('sweepJobLogs — size-cap LRU eviction', () => {
  it('evicts oldest files when total exceeds maxBytes', async () => {
    await makeLogFile('200', 'a'.repeat(10_000), 5 * 3600 * 1000);
    await makeLogFile('201', 'b'.repeat(10_000), 4 * 3600 * 1000);
    await makeLogFile('202', 'c'.repeat(10_000), 3 * 3600 * 1000);

    const result = await sweepJobLogs({
      cachePoolPath: tmpDir,
      retentionDays: 30,
      maxBytes: 15_000, // forces eviction of at least 1 file
      jobRepo: makeJobRepoMock([]),
    });
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);
    expect(result.remainingBytes).toBeLessThanOrEqual(15_000);
  });
});
