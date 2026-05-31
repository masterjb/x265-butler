import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

// Mock hash + ffprobe so the orchestrator test stays hermetic and fast.
const { mockHashFile, mockFfprobe } = vi.hoisted(() => ({
  mockHashFile: vi.fn<(filePath: string) => Promise<string>>(),
  mockFfprobe: vi.fn<
    (filePath: string) => Promise<{
      codec: string;
      bitrate: number | null;
      durationSeconds: number | null;
      width: number | null;
      height: number | null;
      container: string;
    } | null>
  >(),
}));

vi.mock('@/src/lib/scan/hash', () => ({
  hashFile: mockHashFile,
  default: { hashFile: mockHashFile },
}));

vi.mock('@/src/lib/scan/ffprobe', () => ({
  ffprobe: mockFfprobe,
  default: { ffprobe: mockFfprobe },
}));

import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import type { ShareRepo } from '@/src/lib/db/repos/share';
import { runScan } from '@/src/lib/scan/orchestrator';
import {
  __forTests_setDb,
  __forTests_resetDb,
  fileRepo as fileRepoFn,
  shareRepo as shareRepoFn,
} from '@/src/lib/db';
import { logger } from '@/src/lib/logger';

type Db = InstanceType<typeof Database>;

const ABOVE_MIN = 2 * 1024 * 1024; // 2 MiB
const probeResult = {
  codec: 'h264',
  bitrate: 5_000_000,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  container: 'mov,mp4,m4a',
};

function writeSized(p: string, sizeBytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(sizeBytes));
}

describe('runScan', () => {
  let tmpdir: string;
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-orch-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    // 14-02: migration 0026 auto-creates "Library" share for /media; clear so
    // these tests stay on the empty-shares fallback path (opts.rootPath).
    db.prepare('DELETE FROM shares').run();
    __forTests_setDb(db);
    repo = makeFileRepo(db);
    mockHashFile.mockReset();
    mockFfprobe.mockReset();
    mockHashFile.mockResolvedValue('h'.repeat(64));
    mockFfprobe.mockResolvedValue(probeResult);
  });

  afterEach(() => {
    __forTests_resetDb();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_runScan_when_first_run_then_filesAdded_equals_count_of_matching_files', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'sub', 'b.mp4'), ABOVE_MIN);
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesScanned).toBe(2);
    expect(result.filesAdded).toBe(2);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesUnchanged).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(repo.count()).toBe(2);
  });

  it('test_runScan_when_second_run_no_changes_then_filesUnchanged_equals_count', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesScanned).toBe(1);
    expect(result.filesAdded).toBe(0);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesUnchanged).toBe(1);
    expect(result.filesFailed).toBe(0);
  });

  it('test_runScan_when_mtime_changes_then_filesUpdated_increments', async () => {
    const filePath = path.join(tmpdir, 'a.mp4');
    writeSized(filePath, ABOVE_MIN);
    await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    fs.utimesSync(filePath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesScanned).toBe(1);
    expect(result.filesAdded).toBe(0);
    expect(result.filesUpdated).toBe(1);
    expect(result.filesUnchanged).toBe(0);
    expect(result.filesFailed).toBe(0);
  });

  it('test_runScan_when_ffprobe_returns_null_then_upserts_with_null_metadata_filesAdded_increments', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    mockFfprobe.mockResolvedValueOnce(null);
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesAdded).toBe(1);
    expect(result.filesFailed).toBe(0);
    const row = repo.findByPath(path.join(tmpdir, 'a.mp4'));
    expect(row?.codec).toBeNull();
    expect(row?.bitrate).toBeNull();
    expect(row?.content_hash).toBe('h'.repeat(64));
  });

  it('test_runScan_when_ffprobe_rejects_then_upserts_with_null_metadata_filesAdded_increments', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    mockFfprobe.mockRejectedValueOnce(new Error('ffprobe blew up'));
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesAdded).toBe(1);
    expect(result.filesFailed).toBe(0);
    const row = repo.findByPath(path.join(tmpdir, 'a.mp4'));
    expect(row?.codec).toBeNull();
    expect(row?.content_hash).toBe('h'.repeat(64));
  });

  // audit-added M6: hash fail on existing row → touchLastScanned, no upsert
  it('test_runScan_when_hash_fails_on_existing_row_then_filesFailed_and_touchLastScanned_called', async () => {
    const filePath = path.join(tmpdir, 'a.mp4');
    writeSized(filePath, ABOVE_MIN);
    // First scan: succeeds, hash = 'h'.repeat(64)
    await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    const initial = repo.findByPath(filePath);
    expect(initial).toBeDefined();
    const initialLastScanned = initial!.last_scanned_at;
    const initialHash = initial!.content_hash;

    // Bump mtime so we leave the fast path
    const bumpedTime = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, bumpedTime, bumpedTime);

    // Second scan: hash throws
    mockHashFile.mockRejectedValueOnce(new Error('I/O error'));
    // Wait a second so the second last_scanned_at is greater
    await new Promise((r) => setTimeout(r, 1100));
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesFailed).toBe(1);
    expect(result.filesAdded).toBe(0);
    expect(result.filesUpdated).toBe(0);

    const refreshed = repo.findByPath(filePath);
    expect(refreshed).toBeDefined();
    // last_scanned_at must have advanced (M6 — row not stale)
    expect(refreshed!.last_scanned_at).toBeGreaterThan(initialLastScanned);
    // content_hash unchanged because hash failed
    expect(refreshed!.content_hash).toBe(initialHash);
  });

  it('test_runScan_when_hash_fails_on_new_file_then_filesFailed_and_no_row_inserted', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    mockHashFile.mockRejectedValueOnce(new Error('I/O error'));
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.filesFailed).toBe(1);
    expect(result.filesAdded).toBe(0);
    expect(repo.count()).toBe(0);
  });

  it('test_runScan_returns_counters_that_sum_to_filesScanned', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'b.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'c.mp4'), ABOVE_MIN);
    mockHashFile.mockRejectedValueOnce(new Error('I/O error')); // first file fails
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(
      result.filesAdded + result.filesUpdated + result.filesUnchanged + result.filesFailed,
    ).toBe(result.filesScanned);
  });

  it('test_runScan_returns_durationMs_and_timestamps_in_seconds', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    const beforeTime = Math.floor(Date.now() / 1000);
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeGreaterThanOrEqual(beforeTime);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.rootPath).toBe(tmpdir);
  });

  it('test_runScan_when_walker_throws_on_bad_root_then_propagates_error', async () => {
    await expect(
      runScan({ rootPath: '/nonexistent-path-12345', extensions: ['mp4'], minSizeMb: 1 }, repo),
    ).rejects.toThrow();
  });
});

// 14-02: per-share dispatch suite — shareRepo injection via __forTests_setDb so
// orchestrator's defaultShareRepo() reads the same DB as the local repo.
describe('runScan multi-share (14-02)', () => {
  let tmpdir: string;
  let db: Db;
  let repo: FileRepo;
  let shares: ShareRepo;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-multishare-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    // Migration 0026 auto-inserts a "Library" share from seeded scan_root setting.
    // Tests need a clean shares table to assert deterministic dispatch.
    db.prepare('DELETE FROM shares').run();
    __forTests_setDb(db);
    repo = fileRepoFn();
    shares = shareRepoFn();
    mockHashFile.mockReset();
    mockFfprobe.mockReset();
    mockHashFile.mockResolvedValue('h'.repeat(64));
    mockFfprobe.mockResolvedValue(probeResult);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    __forTests_resetDb();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_runScan_when_shareRepo_empty_then_falls_back_to_opts_and_share_id_null', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    const result = await runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo);
    expect(result.byShare).toBeUndefined();
    expect(result.filesScanned).toBe(1);
    expect(result.filesAdded).toBe(1);
    const row = repo.findByPath(path.join(tmpdir, 'a.mp4'));
    expect(row?.share_id).toBeNull();
    // Fallback info-log fired with correct rootPath
    const fallbackCall = infoSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'scan_empty_shares_fallback',
    );
    expect(fallbackCall).toBeDefined();
    expect((fallbackCall![0] as { rootPath: string }).rootPath).toBe(tmpdir);
  });

  it('test_runScan_when_one_share_then_iterates_and_writes_share_id', async () => {
    const mDir = path.join(tmpdir, 'm');
    fs.mkdirSync(mDir, { recursive: true });
    const share = shares.create({
      name: 'Movies',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    writeSized(path.join(mDir, 'a.mp4'), ABOVE_MIN);
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.byShare).toBeDefined();
    expect(result.byShare).toHaveLength(1);
    expect(result.byShare![0].shareId).toBe(share.id);
    expect(result.byShare![0].filesScanned).toBe(1);
    expect(result.filesScanned).toBe(1);
    const row = repo.findByPath(path.join(mDir, 'a.mp4'));
    expect(row?.share_id).toBe(share.id);
  });

  it('test_runScan_when_two_shares_then_writes_correct_share_id_per_path', async () => {
    const mDir = path.join(tmpdir, 'm');
    const sDir = path.join(tmpdir, 's');
    fs.mkdirSync(mDir, { recursive: true });
    fs.mkdirSync(sDir, { recursive: true });
    const m = shares.create({
      name: 'Movies',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    const s = shares.create({
      name: 'Shows',
      path: sDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    writeSized(path.join(mDir, 'a.mkv'), ABOVE_MIN);
    writeSized(path.join(mDir, 'sub', 'b.mkv'), ABOVE_MIN);
    writeSized(path.join(sDir, 'c.mp4'), ABOVE_MIN);
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.byShare).toHaveLength(2);
    expect(result.byShare![0].shareId).toBe(m.id);
    expect(result.byShare![1].shareId).toBe(s.id);
    expect(result.filesScanned).toBe(3);
    expect(repo.findByPath(path.join(mDir, 'a.mkv'))?.share_id).toBe(m.id);
    expect(repo.findByPath(path.join(mDir, 'sub', 'b.mkv'))?.share_id).toBe(m.id);
    expect(repo.findByPath(path.join(sDir, 'c.mp4'))?.share_id).toBe(s.id);
  });

  it('test_runScan_when_per_share_filter_isolates_extensions', async () => {
    const mDir = path.join(tmpdir, 'm');
    const sDir = path.join(tmpdir, 's');
    fs.mkdirSync(mDir, { recursive: true });
    fs.mkdirSync(sDir, { recursive: true });
    shares.create({
      name: 'Movies',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    shares.create({
      name: 'Shows',
      path: sDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    writeSized(path.join(mDir, 'a.mkv'), ABOVE_MIN);
    writeSized(path.join(mDir, 'skip.mp4'), ABOVE_MIN);
    writeSized(path.join(sDir, 'c.mp4'), ABOVE_MIN);
    writeSized(path.join(sDir, 'skip.mkv'), ABOVE_MIN);
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.filesScanned).toBe(2);
    expect(result.filesAdded).toBe(2);
    expect(repo.findByPath(path.join(mDir, 'a.mkv'))).toBeDefined();
    expect(repo.findByPath(path.join(mDir, 'skip.mp4'))).toBeUndefined();
    expect(repo.findByPath(path.join(sDir, 'c.mp4'))).toBeDefined();
    expect(repo.findByPath(path.join(sDir, 'skip.mkv'))).toBeUndefined();
  });

  it('test_runScan_when_per_share_filter_isolates_minSize', async () => {
    const bigDir = path.join(tmpdir, 'big');
    const smallDir = path.join(tmpdir, 'small');
    fs.mkdirSync(bigDir, { recursive: true });
    fs.mkdirSync(smallDir, { recursive: true });
    shares.create({
      name: 'Big',
      path: bigDir,
      min_size_mb: 50,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    shares.create({
      name: 'Small',
      path: smallDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    writeSized(path.join(bigDir, 'a.mkv'), ABOVE_MIN); // 2MB — below 50MB threshold
    writeSized(path.join(smallDir, 'b.mkv'), ABOVE_MIN); // 2MB — above 1MB threshold
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.filesScanned).toBe(1);
    expect(repo.findByPath(path.join(bigDir, 'a.mkv'))).toBeUndefined();
    expect(repo.findByPath(path.join(smallDir, 'b.mkv'))).toBeDefined();
  });

  it('test_runScan_when_per_share_filter_isolates_maxDepth', async () => {
    const shallowDir = path.join(tmpdir, 'shallow');
    const deepDir = path.join(tmpdir, 'deep');
    fs.mkdirSync(shallowDir, { recursive: true });
    fs.mkdirSync(deepDir, { recursive: true });
    shares.create({
      name: 'Shallow',
      path: shallowDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: 0,
    });
    shares.create({
      name: 'Deep',
      path: deepDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    writeSized(path.join(shallowDir, 'a.mkv'), ABOVE_MIN);
    writeSized(path.join(shallowDir, 'sub', 'b.mkv'), ABOVE_MIN);
    writeSized(path.join(deepDir, 'sub', 'c.mkv'), ABOVE_MIN);
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(repo.findByPath(path.join(shallowDir, 'a.mkv'))).toBeDefined();
    expect(repo.findByPath(path.join(shallowDir, 'sub', 'b.mkv'))).toBeUndefined();
    expect(repo.findByPath(path.join(deepDir, 'sub', 'c.mkv'))).toBeDefined();
    expect(result.filesScanned).toBe(2);
  });

  it('test_runScan_counter_invariant_top_equals_sum_of_byShare', async () => {
    const aDir = path.join(tmpdir, 'a');
    const bDir = path.join(tmpdir, 'b');
    const cDir = path.join(tmpdir, 'c');
    fs.mkdirSync(aDir, { recursive: true });
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(cDir, { recursive: true });
    shares.create({
      name: 'A',
      path: aDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    shares.create({
      name: 'B',
      path: bDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    shares.create({
      name: 'C',
      path: cDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    writeSized(path.join(aDir, 'a1.mp4'), ABOVE_MIN);
    writeSized(path.join(aDir, 'a2.mp4'), ABOVE_MIN);
    writeSized(path.join(bDir, 'b1.mp4'), ABOVE_MIN);
    writeSized(path.join(cDir, 'c1.mp4'), ABOVE_MIN);
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.byShare).toHaveLength(3);
    const sumScanned = result.byShare!.reduce((acc, s) => acc + s.filesScanned, 0);
    const sumAdded = result.byShare!.reduce((acc, s) => acc + s.filesAdded, 0);
    const sumUpdated = result.byShare!.reduce((acc, s) => acc + s.filesUpdated, 0);
    const sumUnchanged = result.byShare!.reduce((acc, s) => acc + s.filesUnchanged, 0);
    const sumFailed = result.byShare!.reduce((acc, s) => acc + s.filesFailed, 0);
    expect(result.filesScanned).toBe(sumScanned);
    expect(result.filesAdded).toBe(sumAdded);
    expect(result.filesUpdated).toBe(sumUpdated);
    expect(result.filesUnchanged).toBe(sumUnchanged);
    expect(result.filesFailed).toBe(sumFailed);
    expect(sumAdded + sumUpdated + sumUnchanged + sumFailed).toBe(sumScanned);
  });

  it('test_runScan_filesVanished_runs_once_globally_not_per_share', async () => {
    const mDir = path.join(tmpdir, 'm');
    const sDir = path.join(tmpdir, 's');
    fs.mkdirSync(mDir, { recursive: true });
    fs.mkdirSync(sDir, { recursive: true });
    shares.create({
      name: 'M',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    shares.create({
      name: 'S',
      path: sDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    // Pre-seed an "old" file row that won't be touched by this scan run.
    repo.upsertByPath({
      path: path.join(mDir, 'old.mkv'),
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mov',
      last_scanned_at: 1,
      share_id: null,
    });
    // No files on disk for either share → vanished sweep marks the pre-seeded row.
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.filesVanished).toBe(1);
    const row = repo.findByPath(path.join(mDir, 'old.mkv'));
    expect(row?.status).toBe('vanished');
  });

  it('test_runScan_when_one_share_throws_then_others_continue', async () => {
    const goodDir = path.join(tmpdir, 'good');
    fs.mkdirSync(goodDir, { recursive: true });
    const bad = shares.create({
      name: 'Bad',
      path: '/nonexistent-share-path-12345',
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    const good = shares.create({
      name: 'Good',
      path: goodDir,
      min_size_mb: 1,
      extensions_csv: 'mp4',
      max_depth: null,
    });
    writeSized(path.join(goodDir, 'c.mp4'), ABOVE_MIN);
    const result = await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    expect(result.byShare).toHaveLength(2);
    expect(result.byShare![0]).toEqual({
      shareId: bad.id,
      name: 'Bad',
      rootPath: '/nonexistent-share-path-12345',
      filesScanned: 0,
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesFailed: 0,
    });
    expect(result.byShare![1].shareId).toBe(good.id);
    expect(result.byShare![1].filesScanned).toBe(1);
    expect(result.filesScanned).toBe(1);
    // scan_share_failed warn fired with bad shareId
    const failCall = warnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'scan_share_failed',
    );
    expect(failCall).toBeDefined();
    expect((failCall![0] as { shareId: number }).shareId).toBe(bad.id);
  });

  it('test_runScan_when_share_deleted_then_recreated_rebinds_orphans_via_fast_path', async () => {
    const mDir = path.join(tmpdir, 'm');
    fs.mkdirSync(mDir, { recursive: true });
    const filePath = path.join(mDir, 'x.mkv');
    writeSized(filePath, ABOVE_MIN);

    // Round 1: share id=N, scan inserts file with share_id=N
    const share1 = shares.create({
      name: 'M1',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    const row1 = repo.findByPath(filePath);
    expect(row1?.share_id).toBe(share1.id);

    // Snapshot the mtime so we can restore it after share delete to keep fast-path
    const originalMtime = row1!.mtime;

    // Remove share → FK SET NULL on file row.
    shares.remove(share1.id);
    expect(repo.findByPath(filePath)?.share_id).toBeNull();

    // Recreate share at same path → new id.
    const share2 = shares.create({
      name: 'M2',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    // Restore mtime so size+mtime unchanged → fast-path triggers.
    fs.utimesSync(filePath, originalMtime, originalMtime);

    await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    const row2 = repo.findByPath(filePath);
    expect(row2?.share_id).toBe(share2.id);
    expect(row2?.size_bytes).toBe(row1!.size_bytes);
    expect(row2?.mtime).toBe(row1!.mtime);
    expect(row2?.content_hash).toBe(row1!.content_hash);
  });

  it('test_runScan_when_sweepSidecarTmpFiles_called_per_share', async () => {
    const mDir = path.join(tmpdir, 'm');
    const sDir = path.join(tmpdir, 's');
    fs.mkdirSync(mDir, { recursive: true });
    fs.mkdirSync(sDir, { recursive: true });
    shares.create({
      name: 'M',
      path: mDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    shares.create({
      name: 'S',
      path: sDir,
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    // Leftover tmp sidecars on each share rootPath.
    fs.writeFileSync(path.join(mDir, '.x.mkv.x265-butler.json.tmp'), '');
    fs.writeFileSync(path.join(sDir, '.y.mkv.x265-butler.json.tmp'), '');
    await runScan({ rootPath: '<ignored>', extensions: [], minSizeMb: 0 }, repo);
    // sweepSidecarTmpFiles deletes leftover .tmp files at each share rootPath.
    expect(fs.existsSync(path.join(mDir, '.x.mkv.x265-butler.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(sDir, '.y.mkv.x265-butler.json.tmp'))).toBe(false);
  });
});
