import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeShareRepo, type ShareRepo } from '@/src/lib/db/repos/share';
import type { FileUpsertInput } from '@/src/lib/db/schema';

type Db = InstanceType<typeof Database>;

const baseInput = (overrides: Partial<FileUpsertInput> = {}): FileUpsertInput => ({
  path: '/media/movies/example.mp4',
  size_bytes: 100_000_000,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 5_000_000,
  duration_seconds: 7200,
  width: 1920,
  height: 1080,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  last_scanned_at: 1_700_000_500,
  share_id: null,
  ...overrides,
});

describe('makeFileRepo', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_upsertByPath_when_path_does_not_exist_then_inserts_and_returns_full_row', () => {
    const before = repo.count();
    expect(before).toBe(0);
    const row = repo.upsertByPath(baseInput());
    expect(row.id).toBeGreaterThan(0);
    expect(row.path).toBe('/media/movies/example.mp4');
    expect(row.size_bytes).toBe(100_000_000);
    expect(row.codec).toBe('h264');
    expect(row.status).toBe('pending');
    expect(row.created_at).toBeGreaterThan(0);
    expect(repo.count()).toBe(1);
  });

  it('test_upsertByPath_when_size_and_mtime_unchanged_then_only_last_scanned_at_updates', () => {
    const inserted = repo.upsertByPath(baseInput({ last_scanned_at: 1_700_000_500 }));
    const initialCreatedAt = inserted.created_at;
    const refreshed = repo.upsertByPath(baseInput({ last_scanned_at: 1_700_000_999 }));
    expect(refreshed.id).toBe(inserted.id);
    expect(refreshed.last_scanned_at).toBe(1_700_000_999);
    expect(refreshed.size_bytes).toBe(inserted.size_bytes);
    expect(refreshed.mtime).toBe(inserted.mtime);
    expect(refreshed.content_hash).toBe(inserted.content_hash);
    expect(refreshed.codec).toBe(inserted.codec);
    expect(refreshed.created_at).toBe(initialCreatedAt);
    expect(repo.count()).toBe(1);
  });

  it('test_upsertByPath_when_mtime_changed_then_updates_all_metadata_fields', () => {
    const inserted = repo.upsertByPath(baseInput());
    const updated = repo.upsertByPath(
      baseInput({
        mtime: 1_700_001_000,
        content_hash: 'b'.repeat(64),
        codec: 'hevc',
        bitrate: 3_000_000,
      }),
    );
    expect(updated.id).toBe(inserted.id);
    expect(updated.mtime).toBe(1_700_001_000);
    expect(updated.content_hash).toBe('b'.repeat(64));
    expect(updated.codec).toBe('hevc');
    expect(updated.bitrate).toBe(3_000_000);
    expect(repo.count()).toBe(1);
  });

  it('test_findByPath_when_no_match_then_returns_undefined', () => {
    expect(repo.findByPath('/nope')).toBeUndefined();
  });

  it('test_findByContentHash_when_match_then_returns_row', () => {
    repo.upsertByPath(baseInput({ content_hash: 'c'.repeat(64) }));
    const found = repo.findByContentHash('c'.repeat(64));
    expect(found).toBeDefined();
    expect(found?.content_hash).toBe('c'.repeat(64));
  });

  it('test_findByContentHash_when_no_match_then_returns_undefined', () => {
    expect(repo.findByContentHash('z'.repeat(64))).toBeUndefined();
  });

  it('test_count_when_multiple_paths_then_returns_correct_total', () => {
    repo.upsertByPath(baseInput({ path: '/media/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/media/b.mp4' }));
    repo.upsertByPath(baseInput({ path: '/media/c.mp4' }));
    expect(repo.count()).toBe(3);
  });

  // audit-added M6: touchLastScanned helper for hash-failure orchestration.
  it('test_touchLastScanned_when_called_then_updates_only_last_scanned_at', () => {
    const inserted = repo.upsertByPath(baseInput({ last_scanned_at: 1_700_000_500 }));
    repo.touchLastScanned(inserted.id, 1_700_999_999);
    const refreshed = repo.getById(inserted.id);
    expect(refreshed?.last_scanned_at).toBe(1_700_999_999);
    expect(refreshed?.size_bytes).toBe(inserted.size_bytes);
    expect(refreshed?.content_hash).toBe(inserted.content_hash);
  });

  // audit-added S10: numeric CHECK constraints on file table.
  it('test_upsertByPath_when_negative_size_then_check_constraint_rejects', () => {
    expect(() => repo.upsertByPath(baseInput({ size_bytes: -1 }))).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('test_upsertByPath_when_negative_bitrate_then_check_constraint_rejects', () => {
    expect(() => repo.upsertByPath(baseInput({ bitrate: -1 }))).toThrow(/CHECK constraint failed/);
  });

  it('test_upsertByPath_when_null_metadata_then_persists_nulls', () => {
    const row = repo.upsertByPath(
      baseInput({
        codec: null,
        bitrate: null,
        duration_seconds: null,
        width: null,
        height: null,
        container: null,
      }),
    );
    expect(row.codec).toBeNull();
    expect(row.bitrate).toBeNull();
    expect(row.duration_seconds).toBeNull();
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
    expect(row.container).toBeNull();
  });
});

// 01-04 additions: listPaginated + countByStatus

function seedRows(repo: FileRepo, n: number, prefix = '/media/seed/file') {
  for (let i = 0; i < n; i++) {
    repo.upsertByPath(
      baseInput({
        path: `${prefix}-${i.toString().padStart(4, '0')}.mp4`,
        size_bytes: 1000 + i * 100,
        bitrate: 100_000 + i * 1000,
        duration_seconds: 60 + i,
        last_scanned_at: 1_700_000_000 + i,
        content_hash: i.toString(16).padStart(64, '0'),
      }),
    );
  }
}

describe('fileRepo.listPaginated (01-04)', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_listPaginated_when_empty_db_then_zero_rows_zero_total', () => {
    const result = repo.listPaginated({ page: 1, size: 50, sort: 'size', dir: 'desc' });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('test_listPaginated_when_default_sort_then_size_desc_with_id_tiebreak', () => {
    seedRows(repo, 5);
    const result = repo.listPaginated({ page: 1, size: 10, sort: 'size', dir: 'desc' });
    expect(result.total).toBe(5);
    expect(result.rows.map((r) => r.size_bytes)).toEqual([1400, 1300, 1200, 1100, 1000]);
  });

  it('test_listPaginated_when_page_2_size_10_then_skips_first_10', () => {
    seedRows(repo, 25);
    const result = repo.listPaginated({ page: 2, size: 10, sort: 'size', dir: 'asc' });
    expect(result.total).toBe(25);
    expect(result.rows).toHaveLength(10);
    expect(result.rows[0].size_bytes).toBe(1000 + 10 * 100);
  });

  it('test_listPaginated_when_q_then_LIKE_substring_match', () => {
    repo.upsertByPath(
      baseInput({ path: '/media/movies/Interstellar.mp4', content_hash: 'h1'.padStart(64, '0') }),
    );
    repo.upsertByPath(
      baseInput({ path: '/media/series/Foundation.mp4', content_hash: 'h2'.padStart(64, '0') }),
    );
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      q: 'foundation',
      sort: 'size',
      dir: 'desc',
    });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/media/series/Foundation.mp4');
  });

  // audit-added M7: case-insensitive Unicode search via LOWER()
  it('test_listPaginated_when_q_unicode_uppercase_then_matches_lowercase_path', () => {
    repo.upsertByPath(
      baseInput({ path: '/media/Filme/Süße Träume.mp4', content_hash: 'u1'.padStart(64, '0') }),
    );
    const result = repo.listPaginated({ page: 1, size: 50, q: 'süße', sort: 'size', dir: 'desc' });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/media/Filme/Süße Träume.mp4');
  });

  it('test_listPaginated_when_q_contains_LIKE_wildcards_then_escaped', () => {
    repo.upsertByPath(
      baseInput({ path: '/media/literal_underscore.mp4', content_hash: 'w1'.padStart(64, '0') }),
    );
    repo.upsertByPath(
      baseInput({ path: '/media/anyXanything.mp4', content_hash: 'w2'.padStart(64, '0') }),
    );
    // `_` should match only the literal underscore, not the X (which a raw `_` wildcard would).
    const result = repo.listPaginated({ page: 1, size: 50, q: '_', sort: 'size', dir: 'desc' });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/media/literal_underscore.mp4');
  });

  it('test_listPaginated_when_q_contains_percent_then_escaped_to_literal', () => {
    repo.upsertByPath(
      baseInput({ path: '/media/100%-rated.mp4', content_hash: 'p1'.padStart(64, '0') }),
    );
    repo.upsertByPath(
      baseInput({ path: '/media/other.mp4', content_hash: 'p2'.padStart(64, '0') }),
    );
    const result = repo.listPaginated({ page: 1, size: 50, q: '%', sort: 'size', dir: 'desc' });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/media/100%-rated.mp4');
  });

  it('test_listPaginated_when_status_filter_then_returns_only_matching_status', () => {
    repo.upsertByPath(baseInput({ path: '/p1.mp4', content_hash: 's1'.padStart(64, '0') }));
    // Manually flip status to non-default for one row so the filter has something to match.
    db.prepare("UPDATE file SET status = 'failed' WHERE path = '/p1.mp4'").run();
    repo.upsertByPath(baseInput({ path: '/p2.mp4', content_hash: 's2'.padStart(64, '0') }));
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      status: 'failed',
      sort: 'size',
      dir: 'desc',
    });
    expect(result.total).toBe(1);
    expect(result.rows[0].status).toBe('failed');
  });

  it('test_listPaginated_when_status_all_then_no_filter', () => {
    seedRows(repo, 3);
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      status: 'all',
      sort: 'size',
      dir: 'desc',
    });
    expect(result.total).toBe(3);
  });

  it('test_listPaginated_when_sort_scanned_asc_then_ordered_by_last_scanned_at', () => {
    seedRows(repo, 3);
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'scanned',
      dir: 'asc',
    });
    expect(result.rows.map((r) => r.last_scanned_at)).toEqual([
      1_700_000_000, 1_700_000_001, 1_700_000_002,
    ]);
  });

  it('test_listPaginated_when_page_out_of_range_then_empty_rows_but_accurate_total', () => {
    seedRows(repo, 3);
    const result = repo.listPaginated({ page: 10, size: 50, sort: 'size', dir: 'desc' });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(3);
  });
});

// 02-01: setStatus + OCC + version bumps + invalid-status guard
describe('fileRepo.setStatus (02-01 OCC)', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_setStatus_when_expectedVersion_matches_then_updates_status_and_bumps_version', () => {
    const inserted = repo.upsertByPath(baseInput());
    expect(inserted.version).toBe(0);
    expect(repo.setStatus(inserted.id, 'queued', 0)).toBe(true);
    const refreshed = repo.getById(inserted.id);
    expect(refreshed?.status).toBe('queued');
    expect(refreshed?.version).toBe(1);
  });

  it('test_setStatus_when_expectedVersion_stale_then_no_update_returns_false', () => {
    const inserted = repo.upsertByPath(baseInput());
    expect(repo.setStatus(inserted.id, 'queued', 0)).toBe(true);
    expect(repo.setStatus(inserted.id, 'encoding', 0)).toBe(false);
    const refreshed = repo.getById(inserted.id);
    expect(refreshed?.status).toBe('queued');
    expect(refreshed?.version).toBe(1);
  });

  it('test_setStatus_when_expectedVersion_current_after_bump_then_succeeds', () => {
    const inserted = repo.upsertByPath(baseInput());
    expect(repo.setStatus(inserted.id, 'queued', 0)).toBe(true);
    expect(repo.setStatus(inserted.id, 'encoding', 1)).toBe(true);
    expect(repo.getById(inserted.id)?.version).toBe(2);
  });

  it('test_setStatus_when_id_missing_then_returns_false', () => {
    expect(repo.setStatus(999, 'done-smaller', 0)).toBe(false);
  });

  // audit-added S7
  it('test_setStatus_when_invalid_status_string_then_throws_TypeError', () => {
    const inserted = repo.upsertByPath(baseInput());
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo.setStatus(inserted.id, 'bogus' as any, 0),
    ).toThrow(TypeError);
    // Verify nothing was written.
    const fresh = repo.getById(inserted.id);
    expect(fresh?.status).toBe('pending');
    expect(fresh?.version).toBe(0);
  });

  it('test_existing_upsertByPath_does_not_change_version_after_metadata_update', () => {
    const inserted = repo.upsertByPath(baseInput());
    expect(inserted.version).toBe(0);
    const updated = repo.upsertByPath(
      baseInput({ mtime: 1_700_001_000, content_hash: 'b'.repeat(64) }),
    );
    expect(updated.version).toBe(0);
  });
});

describe('fileRepo.recoverStaleEncoding (02-04)', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_recoverStaleEncoding_when_no_encoding_rows_then_returns_zero', () => {
    expect(repo.recoverStaleEncoding(1700000000)).toBe(0);
  });

  it('test_recoverStaleEncoding_when_one_encoding_row_then_returns_one_and_marks_interrupted', () => {
    const f = repo.upsertByPath(baseInput());
    repo.setStatus(f.id, 'encoding', 0);
    const recovered = repo.recoverStaleEncoding(1700000000);
    expect(recovered).toBe(1);
    expect(repo.getById(f.id)?.status).toBe('interrupted');
  });

  it('test_recoverStaleEncoding_when_multiple_encoding_rows_then_all_marked', () => {
    const a = repo.upsertByPath({ ...baseInput(), path: '/a.mp4', content_hash: 'a'.repeat(64) });
    const b = repo.upsertByPath({ ...baseInput(), path: '/b.mp4', content_hash: 'b'.repeat(64) });
    const c = repo.upsertByPath({ ...baseInput(), path: '/c.mp4', content_hash: 'c'.repeat(64) });
    repo.setStatus(a.id, 'encoding', 0);
    repo.setStatus(b.id, 'encoding', 0);
    repo.setStatus(c.id, 'encoding', 0);
    expect(repo.recoverStaleEncoding(1700000000)).toBe(3);
    expect(repo.getById(a.id)?.status).toBe('interrupted');
    expect(repo.getById(b.id)?.status).toBe('interrupted');
    expect(repo.getById(c.id)?.status).toBe('interrupted');
  });

  it('test_recoverStaleEncoding_does_not_touch_pending_or_terminal_rows', () => {
    const pending = repo.upsertByPath({
      ...baseInput(),
      path: '/p.mp4',
      content_hash: 'p'.repeat(64),

      share_id: null,
    });
    const done = repo.upsertByPath({
      ...baseInput(),
      path: '/d.mp4',
      content_hash: 'd'.repeat(64),

      share_id: null,
    });
    repo.setStatus(done.id, 'done-smaller', 0);
    expect(repo.recoverStaleEncoding(1700000000)).toBe(0);
    expect(repo.getById(pending.id)?.status).toBe('pending');
    expect(repo.getById(done.id)?.status).toBe('done-smaller');
  });

  it('test_recoverStaleEncoding_bumps_version', () => {
    const f = repo.upsertByPath(baseInput());
    repo.setStatus(f.id, 'encoding', 0);
    const before = repo.getById(f.id)!;
    repo.recoverStaleEncoding(1700000000);
    const after = repo.getById(f.id)!;
    expect(after.version).toBe(before.version + 1);
  });
});

describe('fileRepo.countByStatus (01-04)', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_countByStatus_when_empty_db_then_all_zero_buckets', () => {
    const counts = repo.countByStatus();
    expect(counts.all).toBe(0);
    expect(counts.pending).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.encoding).toBe(0);
  });

  it('test_countByStatus_when_seeded_then_groups_correctly', () => {
    seedRows(repo, 3);
    db.prepare("UPDATE file SET status = 'failed' WHERE path = '/media/seed/file-0000.mp4'").run();
    db.prepare("UPDATE file SET status = 'failed' WHERE path = '/media/seed/file-0001.mp4'").run();
    const counts = repo.countByStatus();
    expect(counts.all).toBe(3);
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBe(2);
    expect(counts.encoding).toBe(0);
  });

  it('test_countByStatus_when_called_then_returns_all_17_status_keys_plus_all', () => {
    // 05-13: 17 FileStatus values (15 pre-05-13 + 'done-not-worth' + 'done-already-evaluated').
    const counts = repo.countByStatus();
    expect(Object.keys(counts).sort()).toEqual(
      [
        'all',
        'pending',
        'queued',
        'encoding',
        'done-smaller',
        'done-larger',
        'skipped-codec',
        'skipped-bitrate',
        'skipped-suffix',
        'skipped-tag',
        'skipped-sidecar',
        'skipped-blocklist',
        'failed',
        'blocklisted',
        'interrupted',
        'vanished',
        'done-not-worth',
        'done-already-evaluated',
      ].sort(),
    );
  });

  // 05-bonus: vanished feature tests.
  it('test_markVanishedNotIn_when_some_rows_older_then_marks_vanished', () => {
    const t1 = 1_700_000_000;
    const t2 = 1_700_000_500;
    const stale = repo.upsertByPath({
      path: '/media/stale.mp4',
      size_bytes: 1024,
      mtime: t1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: t1,

      share_id: null,
    });
    const fresh = repo.upsertByPath({
      path: '/media/fresh.mp4',
      size_bytes: 1024,
      mtime: t2,
      content_hash: 'b'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: t2,

      share_id: null,
    });
    // Mark anything not seen at t2.
    const changed = repo.markVanishedNotIn(t2, ['encoding', 'queued', 'blocklisted']);
    expect(changed).toBe(1);
    expect(repo.getById(stale.id)?.status).toBe('vanished');
    expect(repo.getById(fresh.id)?.status).toBe('pending');
  });

  it('test_markVanishedNotIn_when_protected_status_then_skipped', () => {
    const t1 = 1_700_000_000;
    const file = repo.upsertByPath({
      path: '/media/encoding.mp4',
      size_bytes: 1024,
      mtime: t1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: t1,

      share_id: null,
    });
    repo.setStatus(file.id, 'encoding', file.version);
    const changed = repo.markVanishedNotIn(t1 + 1000, ['encoding', 'queued', 'blocklisted']);
    expect(changed).toBe(0);
    expect(repo.getById(file.id)?.status).toBe('encoding');
  });

  it('test_markVanishedNotIn_when_already_vanished_then_no_op', () => {
    const t1 = 1_700_000_000;
    const file = repo.upsertByPath({
      path: '/media/already-gone.mp4',
      size_bytes: 1024,
      mtime: t1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: t1,

      share_id: null,
    });
    repo.setStatus(file.id, 'vanished', file.version);
    const changed = repo.markVanishedNotIn(t1 + 1000, ['encoding', 'queued', 'blocklisted']);
    expect(changed).toBe(0);
  });

  it('test_upsertByPath_when_existing_row_was_vanished_then_revives_to_pending', () => {
    const file = repo.upsertByPath({
      path: '/media/come-back.mp4',
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
    repo.setStatus(file.id, 'vanished', file.version);
    expect(repo.getById(file.id)?.status).toBe('vanished');

    // File reappears on disk → next scan upserts → row should auto-revive.
    repo.upsertByPath({
      path: '/media/come-back.mp4',
      size_bytes: 1024,
      mtime: 1_700_000_000,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1_700_000_500,

      share_id: null,
    });
    expect(repo.getById(file.id)?.status).toBe('pending');
  });

  it('test_listPaginated_when_default_then_excludes_vanished', () => {
    const visible = repo.upsertByPath({
      path: '/media/visible.mp4',
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1,

      share_id: null,
    });
    const gone = repo.upsertByPath({
      path: '/media/gone.mp4',
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'b'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1,

      share_id: null,
    });
    repo.setStatus(gone.id, 'vanished', gone.version);

    const result = repo.listPaginated({ page: 1, size: 50, sort: 'size', dir: 'desc' });
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(gone.id);
    expect(result.total).toBe(1);
  });

  it('test_listPaginated_when_includeVanished_then_returns_all', () => {
    repo.upsertByPath({
      path: '/media/visible2.mp4',
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1,

      share_id: null,
    });
    const gone = repo.upsertByPath({
      path: '/media/gone2.mp4',
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'b'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1,

      share_id: null,
    });
    repo.setStatus(gone.id, 'vanished', gone.version);

    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
      includeVanished: true,
    });
    expect(result.total).toBe(2);
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(gone.id);
  });

  it('test_listPaginated_when_status_vanished_then_returns_only_vanished', () => {
    const visible = repo.upsertByPath({
      path: '/media/visible3.mp4',
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1,

      share_id: null,
    });
    const gone = repo.upsertByPath({
      path: '/media/gone3.mp4',
      size_bytes: 1024,
      mtime: 1,
      content_hash: 'b'.repeat(64),
      codec: 'h264',
      bitrate: 1_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1,

      share_id: null,
    });
    repo.setStatus(gone.id, 'vanished', gone.version);

    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
      status: 'vanished',
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(gone.id);
    expect(result.rows.map((r) => r.id)).not.toContain(visible.id);
  });

  // 04-01: skipped-sidecar is the 14th FileStatus (was 13).
  it('test_setStatus_when_called_with_skipped_sidecar_then_succeeds', () => {
    const file = repo.upsertByPath({
      path: '/media/test.mp4',
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
    const ok = repo.setStatus(file.id, 'skipped-sidecar', file.version);
    expect(ok).toBe(true);
    const updated = repo.getById(file.id);
    expect(updated?.status).toBe('skipped-sidecar');
  });
});

// 13-06 T2: bulkSetStatusByIds + listEligibleForBlocklistFlip.
describe('makeFileRepo — bulkSetStatusByIds (13-06)', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_empty_ids_returns_zero_no_op', () => {
    const result = repo.bulkSetStatusByIds([], 'blocklisted', ['pending']);
    expect(result).toBe(0);
  });

  it('test_status_guard_excludes_non_matching_rows', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    const b = repo.upsertByPath(baseInput({ path: '/b.mkv' }));
    repo.setStatus(b.id, 'done-smaller', b.version);
    // Both ids passed; only `a` (pending) is in expectedStates → only `a` flips.
    const flipped = repo.bulkSetStatusByIds([a.id, b.id], 'blocklisted', ['pending']);
    expect(flipped).toBe(1);
    expect(repo.getById(a.id)?.status).toBe('blocklisted');
    expect(repo.getById(b.id)?.status).toBe('done-smaller');
  });

  it('test_OCC_version_bumped_on_flip', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    const beforeVersion = a.version;
    repo.bulkSetStatusByIds([a.id], 'blocklisted', ['pending']);
    const after = repo.getById(a.id);
    expect(after?.version).toBe(beforeVersion + 1);
    expect(after?.status).toBe('blocklisted');
  });

  it('test_invalid_newStatus_throws_TypeError', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    expect(() => repo.bulkSetStatusByIds([a.id], 'badstatus' as never, ['pending'])).toThrow(
      TypeError,
    );
  });

  it('test_invalid_expectedState_throws_TypeError', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    expect(() => repo.bulkSetStatusByIds([a.id], 'blocklisted', ['badstate' as never])).toThrow(
      TypeError,
    );
  });

  it('test_empty_expectedStates_throws_TypeError', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    expect(() => repo.bulkSetStatusByIds([a.id], 'blocklisted', [])).toThrow(TypeError);
  });
});

describe('makeFileRepo — listEligibleForBlocklistFlip (13-06)', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_empty_table_returns_empty_array', () => {
    const rows = repo.listEligibleForBlocklistFlip(['pending', 'failed']);
    expect(rows).toEqual([]);
  });

  it('test_single_status_match_returns_only_that_status', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    const b = repo.upsertByPath(baseInput({ path: '/b.mkv' }));
    repo.setStatus(b.id, 'done-smaller', b.version);
    const rows = repo.listEligibleForBlocklistFlip(['pending']);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a.id);
    expect(rows[0].path).toBe('/a.mkv');
    expect(rows[0].status).toBe('pending');
  });

  it('test_multi_status_match_returns_union', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    const b = repo.upsertByPath(baseInput({ path: '/b.mkv' }));
    const c = repo.upsertByPath(baseInput({ path: '/c.mkv' }));
    repo.setStatus(b.id, 'failed', b.version);
    repo.setStatus(c.id, 'done-smaller', c.version);
    const rows = repo.listEligibleForBlocklistFlip(['pending', 'failed']);
    const ids = rows.map((r) => r.id).sort((x, y) => x - y);
    expect(ids).toEqual([a.id, b.id].sort((x, y) => x - y));
  });

  it('test_non_matching_status_excluded', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    repo.setStatus(a.id, 'queued', a.version);
    const rows = repo.listEligibleForBlocklistFlip([
      'pending',
      'failed',
      'interrupted',
      'done-larger',
      'done-not-worth',
    ]);
    expect(rows).toEqual([]);
  });

  it('test_projection_includes_status_field_SR2', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mkv' }));
    const b = repo.upsertByPath(baseInput({ path: '/b.mkv' }));
    repo.setStatus(b.id, 'failed', b.version);
    const rows = repo.listEligibleForBlocklistFlip(['pending', 'failed']);
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    expect(statusById.get(a.id)).toBe('pending');
    expect(statusById.get(b.id)).toBe('failed');
  });

  it('test_runtime_cap_throws_EncodeGuardScopeCapError_M3', async () => {
    // Stress via raw SQL: insert 100_001 rows then assert the cap fires.
    const insertStmt = db.prepare(
      `INSERT INTO file (
         path, size_bytes, mtime, content_hash, codec, bitrate,
         duration_seconds, width, height, container, last_scanned_at, status
       ) VALUES (?, 1024, 1, ?, 'h264', 1000000, 60, 1920, 1080, 'mp4', 1, 'pending')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 100_001; i++) {
        insertStmt.run(`/stress/${i}.mkv`, `${'a'.repeat(60)}${String(i).padStart(4, '0')}`);
      }
    })();
    const { EncodeGuardScopeCapError } = await import('@/src/lib/blocklist/encode-guard');
    expect(() => repo.listEligibleForBlocklistFlip(['pending'])).toThrow(EncodeGuardScopeCapError);
  });

  it('test_invalid_status_throws_TypeError', () => {
    expect(() => repo.listEligibleForBlocklistFlip(['badstate' as never])).toThrow(TypeError);
  });
});

// 14-02: upsertByPath share_id propagation — INSERT + UPDATE + fast-path-
// divergent-rebind paths exercise the FileUpsertInput.share_id wire.
describe('upsertByPath share_id propagation (14-02)', () => {
  let db: Db;
  let repo: FileRepo;
  let shares: ShareRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    repo = makeFileRepo(db);
    shares = makeShareRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_upsertByPath_when_insert_with_share_id_then_persists', () => {
    const s = shares.create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    const row = repo.upsertByPath({ ...baseInput({ path: '/m/x.mkv' }), share_id: s.id });
    expect(row.share_id).toBe(s.id);
    expect(repo.findByPath('/m/x.mkv')?.share_id).toBe(s.id);
  });

  it('test_upsertByPath_when_insert_with_null_share_id_then_persists_null', () => {
    const row = repo.upsertByPath({ ...baseInput({ path: '/legacy/x.mkv' }), share_id: null });
    expect(row.share_id).toBeNull();
  });

  it('test_upsertByPath_when_full_update_changes_share_id_then_overwrites', () => {
    const s1 = shares.create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    const s2 = shares.create({
      name: 'S',
      path: '/s',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    repo.upsertByPath({ ...baseInput({ path: '/m/a.mkv' }), share_id: s1.id });
    repo.upsertByPath({
      ...baseInput({ path: '/m/a.mkv', mtime: 1_700_001_000, content_hash: 'b'.repeat(64) }),
      share_id: s2.id,
    });
    expect(repo.findByPath('/m/a.mkv')?.share_id).toBe(s2.id);
  });

  it('test_upsertByPath_when_fast_path_same_share_id_then_no_op', () => {
    const s = shares.create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    repo.upsertByPath({ ...baseInput({ path: '/m/x.mkv' }), share_id: s.id });
    // Same mtime + size + share_id → fast-path no-op (only last_scanned_at refreshes).
    repo.upsertByPath({
      ...baseInput({ path: '/m/x.mkv', last_scanned_at: 1_700_001_500 }),
      share_id: s.id,
    });
    expect(repo.findByPath('/m/x.mkv')?.share_id).toBe(s.id);
  });

  it('test_upsertByPath_when_fast_path_divergent_share_id_then_rebinds', () => {
    // Orphan-recovery (M1): row exists with share_id=NULL, new scan binds it.
    const inserted = repo.upsertByPath({
      ...baseInput({ path: '/m/orphan.mkv' }),
      share_id: null,
    });
    const s = shares.create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    repo.upsertByPath({
      ...baseInput({ path: '/m/orphan.mkv', last_scanned_at: 1_700_001_500 }),
      share_id: s.id,
    });
    const after = repo.findByPath('/m/orphan.mkv');
    expect(after?.share_id).toBe(s.id);
    expect(after?.last_scanned_at).toBe(1_700_001_500);
    expect(after?.size_bytes).toBe(inserted.size_bytes);
    expect(after?.mtime).toBe(inserted.mtime);
    expect(after?.content_hash).toBe(inserted.content_hash);
  });

  it('test_upsertByPath_when_full_update_share_id_to_null_then_persists_null', () => {
    const s = shares.create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    repo.upsertByPath({ ...baseInput({ path: '/m/y.mkv' }), share_id: s.id });
    repo.upsertByPath({
      ...baseInput({ path: '/m/y.mkv', mtime: 1_700_002_000, content_hash: 'c'.repeat(64) }),
      share_id: null,
    });
    expect(repo.findByPath('/m/y.mkv')?.share_id).toBeNull();
  });

  it('test_share_remove_FK_sets_file_share_id_to_null', () => {
    const s = shares.create({
      name: 'M',
      path: '/m',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    });
    repo.upsertByPath({ ...baseInput({ path: '/m/z.mkv' }), share_id: s.id });
    shares.remove(s.id);
    expect(repo.findByPath('/m/z.mkv')?.share_id).toBeNull();
  });
});

// 14-03: share-axis filter on listPaginated / countByQuery / iterateAll +
// new countOrphaned() method.
describe('fileRepo listPaginated share filter (14-03)', () => {
  let db: Db;
  let repo: FileRepo;
  let shares: ShareRepo;
  let s1Id: number;
  let s2Id: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    repo = makeFileRepo(db);
    shares = makeShareRepo(db);
    s1Id = shares.create({
      name: 'Movies',
      path: '/movies',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    }).id;
    s2Id = shares.create({
      name: 'Series',
      path: '/series',
      min_size_mb: 1,
      extensions_csv: 'mkv',
      max_depth: null,
    }).id;
    // 6 rows: 2× share=s1, 2× share=s2, 2× share=null
    repo.upsertByPath({
      ...baseInput({ path: '/movies/a.mkv', content_hash: 'a'.repeat(64) }),
      share_id: s1Id,
    });
    repo.upsertByPath({
      ...baseInput({ path: '/movies/b.mkv', content_hash: 'b'.repeat(64) }),
      share_id: s1Id,
    });
    repo.upsertByPath({
      ...baseInput({ path: '/series/c.mkv', content_hash: 'c'.repeat(64) }),
      share_id: s2Id,
    });
    repo.upsertByPath({
      ...baseInput({ path: '/series/d.mkv', content_hash: 'd'.repeat(64) }),
      share_id: s2Id,
    });
    repo.upsertByPath({
      ...baseInput({ path: '/legacy/e.mkv', content_hash: 'e'.repeat(64) }),
      share_id: null,
    });
    repo.upsertByPath({
      ...baseInput({ path: '/legacy/f.mkv', content_hash: 'f'.repeat(64) }),
      share_id: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('test_listPaginated_when_shareId_numeric_then_filters_to_that_share', () => {
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
      shareId: s1Id,
    });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.share_id === s1Id)).toBe(true);
  });

  it('test_listPaginated_when_shareId_orphan_then_filters_to_null_share_rows', () => {
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
      shareId: 'orphan',
    });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.share_id === null)).toBe(true);
  });

  it('test_listPaginated_when_shareId_undefined_then_no_filter_back_compat', () => {
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
    });
    expect(result.total).toBe(6);
  });

  it('test_listPaginated_when_shareId_with_status_filter_then_AND_composes', () => {
    db.prepare("UPDATE file SET status = 'failed' WHERE path = '/movies/a.mkv'").run();
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      status: 'failed',
      sort: 'size',
      dir: 'desc',
      shareId: s1Id,
    });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/movies/a.mkv');
    expect(result.rows[0].share_id).toBe(s1Id);
  });

  it('test_countByQuery_and_iterateAll_mirror_listPaginated_for_same_shareId', () => {
    for (const shareId of [s1Id, s2Id, 'orphan' as const, undefined]) {
      const list = repo.listPaginated({
        page: 1,
        size: 50,
        sort: 'size',
        dir: 'desc',
        shareId,
      });
      const count = repo.countByQuery({
        page: 1,
        size: 50,
        sort: 'size',
        dir: 'desc',
        shareId,
      });
      const iter = Array.from(
        repo.iterateAll({ page: 1, size: 50, sort: 'size', dir: 'desc', shareId }),
      );
      expect(count).toBe(list.total);
      expect(iter.map((r) => r.id)).toEqual(list.rows.map((r) => r.id));
    }
  });

  it('test_countOrphaned_when_null_share_rows_present_then_returns_subset_excluding_vanished', () => {
    expect(repo.countOrphaned()).toBe(2);
    db.prepare("UPDATE file SET status = 'vanished' WHERE path = '/legacy/e.mkv'").run();
    expect(repo.countOrphaned()).toBe(1);
  });

  // audit-added SR3: AC-18 AND-composition with deep-link idFilter
  it('test_listPaginated_when_idFilter_and_shareId_mismatch_then_zero_rows_no_crash', () => {
    // file at /movies/a.mkv has share_id=s1Id; ask for it scoped to s2Id → 0 rows
    const aRow = repo.findByPath('/movies/a.mkv');
    expect(aRow).toBeDefined();
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
      idFilter: aRow!.id,
      shareId: s2Id,
    });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  // audit-added M1: AC-16 repo-layer slice — invalid share id
  it('test_listPaginated_when_shareId_nonexistent_then_zero_rows_no_crash', () => {
    const result = repo.listPaginated({
      page: 1,
      size: 50,
      sort: 'size',
      dir: 'desc',
      shareId: 99999,
    });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});
