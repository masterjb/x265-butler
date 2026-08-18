/*
 * 04-02 Task 1: BlocklistRepo CRUD + match semantics + audit M1 + M2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import {
  makeBlocklistRepo,
  matchPathInList,
  type BlocklistRepo,
} from '@/src/lib/db/repos/blocklist';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';

let db: InstanceType<typeof Database>;
let repo: BlocklistRepo;
let fileRepo: FileRepo;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  repo = makeBlocklistRepo(db);
  fileRepo = makeFileRepo(db);
});

afterEach(() => {
  db.close();
});

function seedFile(path: string): { id: number } {
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
  return { id: row.id };
}

describe('BlocklistRepo — add', () => {
  it('test_add_when_file_id_then_creates_row_with_path_pattern_null', () => {
    const file = seedFile('/movies/A.mkv');
    const row = repo.add({ file_id: file.id });
    expect(row.file_id).toBe(file.id);
    expect(row.path_pattern).toBeNull();
    expect(row.reason).toBe('operator');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('test_add_when_path_pattern_then_creates_row_with_file_id_null', () => {
    const row = repo.add({ path_pattern: '/movies/Samples/*' });
    expect(row.file_id).toBeNull();
    expect(row.path_pattern).toBe('/movies/Samples/*');
  });

  it('test_add_when_file_id_already_blocklisted_then_returns_existing_row_idempotent', () => {
    const file = seedFile('/movies/A.mkv');
    const first = repo.add({ file_id: file.id });
    const second = repo.add({ file_id: file.id });
    expect(second.id).toBe(first.id);
    expect(repo.count()).toBe(1);
  });

  it('test_add_when_file_id_AND_path_pattern_both_provided_then_throws', () => {
    const file = seedFile('/movies/A.mkv');
    expect(() => repo.add({ file_id: file.id, path_pattern: '/movies/*' })).toThrow();
  });

  it('test_add_when_neither_provided_then_throws', () => {
    expect(() => repo.add({})).toThrow();
  });

  it('test_add_when_path_pattern_too_long_then_throws', () => {
    expect(() => repo.add({ path_pattern: '/x/'.repeat(2000) })).toThrow();
  });

  it('test_add_when_reason_default_then_operator', () => {
    const row = repo.add({ path_pattern: '/x/*' });
    expect(row.reason).toBe('operator');
  });

  it('test_add_when_reason_auto_failure_explicit_then_persisted', () => {
    const row = repo.add({ path_pattern: '/x/*', reason: 'auto-failure' });
    expect(row.reason).toBe('auto-failure');
  });
});

describe('BlocklistRepo — remove', () => {
  it('test_remove_when_id_exists_then_returns_true_AND_row_gone', () => {
    const row = repo.add({ path_pattern: '/x/*' });
    expect(repo.remove(row.id)).toBe(true);
    expect(repo.findById(row.id)).toBeUndefined();
  });

  it('test_remove_when_id_missing_then_returns_false', () => {
    expect(repo.remove(99999)).toBe(false);
  });
});

describe('BlocklistRepo — find', () => {
  it('test_findById_returns_row', () => {
    const row = repo.add({ path_pattern: '/x/*' });
    const found = repo.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('test_findByFileId_returns_row', () => {
    const file = seedFile('/movies/A.mkv');
    const row = repo.add({ file_id: file.id });
    const found = repo.findByFileId(file.id);
    expect(found?.id).toBe(row.id);
  });

  it('test_findByPattern_returns_row_when_match', () => {
    const row = repo.add({ path_pattern: '/movies/*', reason: 'operator' });
    const found = repo.findByPattern('/movies/*', 'operator');
    expect(found?.id).toBe(row.id);
  });

  it('test_findByPattern_returns_undefined_when_reason_differs', () => {
    repo.add({ path_pattern: '/movies/*', reason: 'operator' });
    expect(repo.findByPattern('/movies/*', 'auto-failure')).toBeUndefined();
  });
});

describe('BlocklistRepo — list', () => {
  it('test_list_paginated_returns_total_AND_rows', () => {
    repo.add({ path_pattern: '/a/*' });
    repo.add({ path_pattern: '/b/*' });
    repo.add({ path_pattern: '/c/*' });
    const result = repo.list({ page: 1, size: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('test_list_clamps_size_to_max_200', () => {
    const result = repo.list({ page: 1, size: 999 });
    expect(result.rows.length).toBeLessThanOrEqual(200);
  });
});

describe('BlocklistRepo — listAllPatterns (audit M2 cache source)', () => {
  it('test_listAllPatterns_returns_only_pattern_rows', () => {
    const file = seedFile('/movies/A.mkv');
    repo.add({ file_id: file.id });
    repo.add({ path_pattern: '/movies/Samples/*' });
    repo.add({ path_pattern: '/scratch/*' });
    const patterns = repo.listAllPatterns();
    expect(patterns).toHaveLength(2);
    expect(patterns.every((p) => p.path_pattern !== null)).toBe(true);
    expect(patterns.every((p) => p.file_id === null)).toBe(true);
  });
});

describe('BlocklistRepo — matchByFileIdOrPath', () => {
  it('test_match_when_fileId_pinned_then_matches', () => {
    const file = seedFile('/movies/A.mkv');
    repo.add({ file_id: file.id });
    expect(repo.matchByFileIdOrPath(file.id, '/movies/A.mkv')).toBe(true);
  });

  it('test_match_when_path_exact_pattern_no_star_then_matches', () => {
    repo.add({ path_pattern: '/movies/A.mkv' });
    expect(repo.matchByFileIdOrPath(null, '/movies/A.mkv')).toBe(true);
  });

  it('test_match_when_pattern_trailing_star_then_prefix_matches', () => {
    repo.add({ path_pattern: '/movies/Samples/*' });
    expect(repo.matchByFileIdOrPath(null, '/movies/Samples/foo.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/Samples/sub/foo.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/Other/foo.mkv')).toBe(false);
  });

  it('test_match_when_pattern_2_stars_prefix_suffix_then_matches', () => {
    repo.add({ path_pattern: '/movies/*.sample.mkv' });
    expect(repo.matchByFileIdOrPath(null, '/movies/A.sample.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/A.mkv')).toBe(false);
  });

  it('test_match_when_double_star_trailing_then_matches_direct_and_subfolders', () => {
    // ** = "any depth below prefix" — UI allows 2 stars, must not silently fail.
    repo.add({ path_pattern: '/movies/Samples/**' });
    expect(repo.matchByFileIdOrPath(null, '/movies/Samples/foo.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/Samples/sub/foo.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/Other/foo.mkv')).toBe(false);
  });

  it('test_match_when_double_star_with_suffix_then_normalizes_to_prefix_suffix', () => {
    // /movies/**.mkv = 2 consecutive stars (API-allowed); normalizes to /movies/*.mkv.
    // Matches anything under /movies/ ending in .mkv, regardless of depth.
    repo.add({ path_pattern: '/movies/**.mkv' });
    expect(repo.matchByFileIdOrPath(null, '/movies/A.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/sub/A.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/sub/A.mp4')).toBe(false);
  });

  it('test_match_when_pattern_two_separate_stars_then_matches_mid_path_per_13_05', () => {
    // 13-05: 2 wildcards (3 split-parts) now match prefix + contains(middle) + suffix.
    // This test originally (04-02) asserted the latent bug (return false); reframed in 13-05
    // to assert the new correct contract per carry-forward P10 2026-05-10 bug-fix.
    repo.add({ path_pattern: '/movies/*/temp/*' });
    expect(repo.matchByFileIdOrPath(null, '/movies/A/temp/x.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/A/feature.mkv')).toBe(false);
  });

  it('test_match_when_no_match_then_false', () => {
    repo.add({ path_pattern: '/scratch/*' });
    expect(repo.matchByFileIdOrPath(null, '/movies/A.mkv')).toBe(false);
  });
});

describe('BlocklistRepo — FK CASCADE on file_id', () => {
  it('test_FK_CASCADE_when_file_deleted_then_pinned_entry_removed', () => {
    const file = seedFile('/movies/A.mkv');
    const entry = repo.add({ file_id: file.id });
    db.prepare('DELETE FROM file WHERE id = ?').run(file.id);
    expect(repo.findById(entry.id)).toBeUndefined();
  });
});

describe('BlocklistRepo — count', () => {
  it('test_count_returns_total', () => {
    expect(repo.count()).toBe(0);
    repo.add({ path_pattern: '/a/*' });
    repo.add({ path_pattern: '/b/*' });
    expect(repo.count()).toBe(2);
  });
});

describe('matchPathInList — pure helper', () => {
  it('test_matchPathInList_when_pattern_matches_then_true', () => {
    const patterns = [
      {
        id: 1,
        file_id: null,
        path_pattern: '/movies/Samples/*',
        reason: 'operator',
        created_at: 0,
      },
    ] as never[];
    expect(matchPathInList('/movies/Samples/x.mkv', patterns)).toBe(true);
    expect(matchPathInList('/movies/Other/x.mkv', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_empty_list_then_false', () => {
    expect(matchPathInList('/movies/x.mkv', [])).toBe(false);
  });

  it('test_matchPathInList_skips_file_id_pinned_entries', () => {
    const patterns = [
      { id: 1, file_id: 1, path_pattern: null, reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('/movies/x.mkv', patterns)).toBe(false);
  });

  // 13-05: 2-star mid-path matching (carry-forward P10 2026-05-10 bug-fix).
  it('test_matchPathInList_when_2star_mid_path_then_matches_at_any_depth', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: '*/Extras/*', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('/movies/A/Extras/x.mkv', patterns)).toBe(true);
    expect(matchPathInList('/shows/S01/Extras/y.mkv', patterns)).toBe(true);
    expect(matchPathInList('/movies/A/Bonus/x.mkv', patterns)).toBe(false);
    expect(matchPathInList('/movies/Extras', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_2star_mid_path_AppleDouble_then_matches', () => {
    const patterns = [
      {
        id: 1,
        file_id: null,
        path_pattern: '*/.AppleDouble/*',
        reason: 'operator',
        created_at: 0,
      },
    ] as never[];
    expect(matchPathInList('/mnt/share/.AppleDouble/._x.mkv', patterns)).toBe(true);
    expect(matchPathInList('/mnt/share/AppleDouble/x.mkv', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_2star_prefix_middle_suffix_then_matches_in_order', () => {
    const patterns = [
      {
        id: 1,
        file_id: null,
        path_pattern: 'prefix*middle*suffix',
        reason: 'operator',
        created_at: 0,
      },
    ] as never[];
    expect(matchPathInList('prefix-X-middle-Y-suffix', patterns)).toBe(true);
    expect(matchPathInList('prefixmiddlesuffix', patterns)).toBe(true);
    expect(matchPathInList('prefix-middle-suffix', patterns)).toBe(true);
    expect(matchPathInList('middle-prefix-suffix', patterns)).toBe(false);
    expect(matchPathInList('prefix-middle', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_2star_middle_order_sensitive_then_order_enforced', () => {
    // APPLY-time spec-fix D3: original AC-6 pattern `*a*b*` is 3 stars (4-split) which conflicts
    // with AC-8 + boundary "3+ stars stays defensive-false". Reformulated to 2-star `a*b*` —
    // order-sensitivity emerges from startsWith('a') anchoring `a` before any `b` indexOf-scan.
    const patterns = [
      { id: 1, file_id: null, path_pattern: 'a*b*', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('aXbY', patterns)).toBe(true);
    expect(matchPathInList('ab', patterns)).toBe(true);
    expect(matchPathInList('bYaX', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_2star_prefix_suffix_overlap_then_false', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: 'a*a*a', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('aa', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_double_star_normalize_then_single_star_semantic', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: '**', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('/x', patterns)).toBe(true);
    expect(matchPathInList('', patterns)).toBe(true);
  });

  it('test_matchPathInList_when_3plus_stars_then_defensive_false', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: '*/a/*/b/*', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('/x/a/y/b/z', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_2star_empty_middle_via_consecutive_stars', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: '/movies/*x*', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('/movies/x', patterns)).toBe(true);
    expect(matchPathInList('/movies/yxz', patterns)).toBe(true);
    expect(matchPathInList('/movies/y', patterns)).toBe(false);
  });

  // audit-added SR2: mixed-empty 3-split shapes
  it('test_matchPathInList_when_2star_trailing_empty_suffix_then_matches', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: 'a*b*', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('axby', patterns)).toBe(true);
    expect(matchPathInList('axb', patterns)).toBe(true);
    expect(matchPathInList('xab', patterns)).toBe(false);
    expect(matchPathInList('a', patterns)).toBe(false);
  });

  it('test_matchPathInList_when_2star_leading_empty_prefix_then_matches', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: '*a*b', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('xayb', patterns)).toBe(true);
    expect(matchPathInList('ayb', patterns)).toBe(true);
    expect(matchPathInList('xay', patterns)).toBe(false);
    expect(matchPathInList('b', patterns)).toBe(false);
  });

  // audit-added SR4: root-prefix match documents semantic for `*/Extras/*` at root
  it('test_matchPathInList_when_2star_mid_path_at_root_then_matches', () => {
    const patterns = [
      { id: 1, file_id: null, path_pattern: '*/Extras/*', reason: 'operator', created_at: 0 },
    ] as never[];
    expect(matchPathInList('/Extras/clip.mkv', patterns)).toBe(true);
  });
});

// audit-added SR3: matchByFileIdOrPath also calls matchPath via the per-call (non-cache)
// DB-driven path; tests prevent silent regression if a future refactor diverges the two call sites.
describe('matchByFileIdOrPath — DB-driven entry point with 2-star mid-path', () => {
  it('test_matchByFileIdOrPath_when_2star_mid_path_pattern_then_matches', () => {
    repo.add({ path_pattern: '*/Extras/*' });
    expect(repo.matchByFileIdOrPath(null, '/movies/A/Extras/clip.mkv')).toBe(true);
    expect(repo.matchByFileIdOrPath(null, '/movies/A/feature.mkv')).toBe(false);
  });

  it('test_matchByFileIdOrPath_when_2star_mid_path_pattern_and_file_id_set_then_pattern_still_evaluated', () => {
    repo.add({ path_pattern: '*/Samples/*' });
    expect(repo.matchByFileIdOrPath(42, '/movies/A/Samples/s.mkv')).toBe(true);
  });
});
