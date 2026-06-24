// 13-06 T1: unit tests for src/lib/blocklist/encode-guard.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeBlocklistRepo, matchPath, type BlocklistRepo } from '@/src/lib/db/repos/blocklist';
import {
  ENCODE_GUARD_ELIGIBLE_STATES,
  ENCODE_GUARD_MAX_FLIP_SCOPE,
  EncodeGuardScopeCapError,
  flipMatchingFilesToBlocklisted,
  requireNotBlocklisted,
} from '@/src/lib/blocklist/encode-guard';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

type Db = InstanceType<typeof Database>;

function seedFile(
  fileRepo: FileRepo,
  db: Db,
  path: string,
  status: FileStatus = 'pending',
): FileRow {
  const row = fileRepo.upsertByPath({
    path,
    size_bytes: 1024,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 1_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_000,

    share_id: null,
  });
  if (status !== 'pending') {
    db.prepare('UPDATE file SET status = ?, version = version + 1 WHERE id = ?').run(
      status,
      row.id,
    );
  }
  const refreshed = fileRepo.getById(row.id);
  if (!refreshed) throw new Error('seed failed');
  return refreshed;
}

describe('requireNotBlocklisted', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let blocklistRepo: BlocklistRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    fileRepo = makeFileRepo(db);
    blocklistRepo = makeBlocklistRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_clean_file_not_blocked', () => {
    const file = seedFile(fileRepo, db, '/movies/clean.mkv');
    const result = requireNotBlocklisted(file, blocklistRepo);
    expect(result).toEqual({ blocked: false });
  });

  it('test_file_pinned_entry_blocks', () => {
    const file = seedFile(fileRepo, db, '/movies/pinned.mkv');
    blocklistRepo.add({ file_id: file.id, reason: 'operator' });
    const result = requireNotBlocklisted(file, blocklistRepo);
    expect(result).toEqual({ blocked: true, reason: 'blocklisted' });
  });

  it('test_pattern_match_blocks', () => {
    const file = seedFile(fileRepo, db, '/movies/Samples/clip.mkv');
    blocklistRepo.add({ path_pattern: '*/Samples/*', reason: 'operator' });
    const result = requireNotBlocklisted(file, blocklistRepo);
    expect(result).toEqual({ blocked: true, reason: 'blocklisted' });
  });

  it('test_pattern_no_match_not_blocked', () => {
    const file = seedFile(fileRepo, db, '/movies/main.mkv');
    blocklistRepo.add({ path_pattern: '*/Samples/*', reason: 'operator' });
    const result = requireNotBlocklisted(file, blocklistRepo);
    expect(result).toEqual({ blocked: false });
  });
});

describe('flipMatchingFilesToBlocklisted', () => {
  let db: Db;
  let fileRepo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    fileRepo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_empty_candidates_returns_zero', () => {
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result).toEqual({ flippedCount: 0, flipped: [] });
  });

  it('test_single_eligible_file_matched_flipped', () => {
    const file = seedFile(fileRepo, db, '/movies/Samples/a.mkv', 'pending');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(1);
    expect(result.flipped).toEqual([{ id: file.id, previousStatus: 'pending' }]);
    expect(fileRepo.getById(file.id)?.status).toBe('blocklisted');
  });

  it('test_multiple_eligible_files_matched_all_flipped', () => {
    const a = seedFile(fileRepo, db, '/movies/Samples/a.mkv', 'pending');
    const b = seedFile(fileRepo, db, '/movies/Samples/b.mkv', 'failed');
    const c = seedFile(fileRepo, db, '/movies/main.mkv', 'pending');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(2);
    const ids = result.flipped.map((f) => f.id).sort((x, y) => x - y);
    expect(ids).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(fileRepo.getById(a.id)?.status).toBe('blocklisted');
    expect(fileRepo.getById(b.id)?.status).toBe('blocklisted');
    expect(fileRepo.getById(c.id)?.status).toBe('pending');
  });

  it('test_zero_match_because_no_eligible_files', () => {
    seedFile(fileRepo, db, '/movies/Samples/a.mkv', 'queued');
    seedFile(fileRepo, db, '/movies/Samples/b.mkv', 'encoding');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(0);
    expect(result.flipped).toEqual([]);
  });

  it('test_zero_match_because_pattern_misses', () => {
    seedFile(fileRepo, db, '/movies/main.mkv', 'pending');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(0);
  });

  it('test_2star_mid_path_pattern_consumes_13_05_matchPath', () => {
    const a = seedFile(fileRepo, db, '/tv/Show/Season01/Extras/clip1.mkv', 'pending');
    const b = seedFile(fileRepo, db, '/tv/Show/Season02/Extras/clip2.mkv', 'failed');
    const c = seedFile(fileRepo, db, '/tv/Show/Season01/Normal/clip3.mkv', 'pending');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Extras/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(2);
    expect(fileRepo.getById(a.id)?.status).toBe('blocklisted');
    expect(fileRepo.getById(b.id)?.status).toBe('blocklisted');
    expect(fileRepo.getById(c.id)?.status).toBe('pending');
  });

  it('test_done_files_NOT_flipped', () => {
    const file = seedFile(fileRepo, db, '/movies/Samples/done.mkv', 'done-smaller');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(0);
    expect(fileRepo.getById(file.id)?.status).toBe('done-smaller');
  });

  it('test_queued_files_NOT_flipped', () => {
    const file = seedFile(fileRepo, db, '/movies/Samples/inflight.mkv', 'queued');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(0);
    expect(fileRepo.getById(file.id)?.status).toBe('queued');
  });

  it('test_flipped_carries_previousStatus_snapshot_SR2', () => {
    const f1 = seedFile(fileRepo, db, '/movies/Samples/1.mkv', 'pending');
    const f2 = seedFile(fileRepo, db, '/movies/Samples/2.mkv', 'failed');
    const f3 = seedFile(fileRepo, db, '/movies/Samples/3.mkv', 'interrupted');
    const f4 = seedFile(fileRepo, db, '/movies/Samples/4.mkv', 'done-larger');
    const f5 = seedFile(fileRepo, db, '/movies/Samples/5.mkv', 'done-not-worth');
    const result = flipMatchingFilesToBlocklisted({
      pattern: '*/Samples/*',
      fileRepo,
      matchPath,
    });
    expect(result.flippedCount).toBe(5);
    const map = new Map(result.flipped.map((f) => [f.id, f.previousStatus]));
    expect(map.get(f1.id)).toBe('pending');
    expect(map.get(f2.id)).toBe('failed');
    expect(map.get(f3.id)).toBe('interrupted');
    expect(map.get(f4.id)).toBe('done-larger');
    expect(map.get(f5.id)).toBe('done-not-worth');
  });

  it('test_propagates_scope_cap_error_M3', () => {
    const stubFileRepo = {
      listEligibleForBlocklistFlip: (): Array<{
        id: number;
        path: string;
        status: FileStatus;
      }> => {
        throw new EncodeGuardScopeCapError(100_001, ENCODE_GUARD_MAX_FLIP_SCOPE);
      },
      bulkSetStatusByIds: (): number => {
        throw new Error('should not be called when listEligible throws');
      },
    } as unknown as FileRepo;
    expect(() =>
      flipMatchingFilesToBlocklisted({
        pattern: '*',
        fileRepo: stubFileRepo,
        matchPath: () => true,
      }),
    ).toThrow(EncodeGuardScopeCapError);
  });
});

describe('ENCODE_GUARD_ELIGIBLE_STATES', () => {
  it('test_exact_5_states', () => {
    expect(ENCODE_GUARD_ELIGIBLE_STATES.size).toBe(5);
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('pending')).toBe(true);
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('failed')).toBe(true);
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('interrupted')).toBe(true);
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('done-larger')).toBe(true);
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('done-not-worth')).toBe(true);
  });

  it('test_queued_and_encoding_NOT_in_set_SR7', () => {
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('queued')).toBe(false);
    expect(ENCODE_GUARD_ELIGIBLE_STATES.has('encoding')).toBe(false);
  });
});
