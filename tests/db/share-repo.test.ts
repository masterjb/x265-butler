/*
 * 14-01 Task 5: ShareRepo CRUD + UNIQUE + nested-path tests.
 * Mirrors tests/db/blocklist-repo.test.ts setup pattern (in-memory + makeShareRepo direct).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeShareRepo, ShareNestedPathError, type ShareRepo } from '@/src/lib/db/repos/share';

let db: InstanceType<typeof Database>;
let repo: ShareRepo;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  // 0001 seeds scan_root='/media' → 0026 backfills a "Library" share at /media.
  // Most tests want a clean slate; wipe shares + reset autoincrement so id=1
  // is predictable per-test.
  db.prepare('DELETE FROM shares').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='shares'").run();
  repo = makeShareRepo(db);
});

afterEach(() => {
  db.close();
});

function sampleInput(overrides: Partial<Parameters<ShareRepo['create']>[0]> = {}) {
  return {
    name: 'Movies',
    path: '/m',
    min_size_mb: 50,
    extensions_csv: 'mkv',
    max_depth: null as number | null,
    ...overrides,
  };
}

describe('shareRepo.create', () => {
  it('test_create_when_valid_input_then_returns_row_with_monotonic_id', () => {
    const start = Math.floor(Date.now() / 1000);
    const first = repo.create(sampleInput({ name: 'A', path: '/a' }));
    const second = repo.create(sampleInput({ name: 'B', path: '/b' }));
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(first.name).toBe('A');
    expect(first.path).toBe('/a');
    expect(first.min_size_mb).toBe(50);
    expect(first.extensions_csv).toBe('mkv');
    expect(first.max_depth).toBeNull();
    expect(first.created_at).toBeGreaterThanOrEqual(start);
    expect(first.updated_at).toBeGreaterThanOrEqual(start);
  });

  it('test_create_when_name_duplicate_then_throws_unique_constraint', () => {
    repo.create(sampleInput({ name: 'Library', path: '/media' }));
    try {
      repo.create(sampleInput({ name: 'Library', path: '/other' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const e = err as { code?: string; message: string };
      expect(e.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
      expect(e.message).toMatch(/shares\.name/);
    }
    expect(repo.listAll()).toHaveLength(1);
  });

  it('test_create_when_path_duplicate_then_throws_unique_constraint', () => {
    repo.create(sampleInput({ name: 'Library', path: '/media' }));
    try {
      repo.create(sampleInput({ name: 'Other', path: '/media' }));
      throw new Error('expected throw');
    } catch (err) {
      // Repo's assertNonNested fires first on same-path → ShareNestedPathError.
      // Both errors are acceptable proof that no duplicate-path row was inserted.
      if (err instanceof ShareNestedPathError) {
        expect(err.direction).toBe('new-nested-under-existing');
        expect(err.conflictingSharePath).toBe('/media');
      } else {
        const e = err as { code?: string; message: string };
        expect(e.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
        expect(e.message).toMatch(/shares\.path/);
      }
    }
    expect(repo.listAll()).toHaveLength(1);
  });

  it('test_create_when_path_nested_under_existing_then_throws_ShareNestedPathError_direction_new_nested_under_existing', () => {
    repo.create(sampleInput({ name: 'Library', path: '/media' }));
    try {
      repo.create(sampleInput({ name: 'Sub', path: '/media/movies' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ShareNestedPathError);
      const e = err as ShareNestedPathError;
      expect(e.direction).toBe('new-nested-under-existing');
      expect(e.conflictingShareName).toBe('Library');
      expect(e.conflictingSharePath).toBe('/media');
      expect(e.message).toContain('nested under');
      expect(e.message).toContain('Library');
    }
    expect(repo.listAll()).toHaveLength(1);
  });

  it('test_create_when_existing_nested_under_new_path_then_throws_ShareNestedPathError_direction_existing_nested_under_new', () => {
    repo.create(sampleInput({ name: 'Library', path: '/media' }));
    try {
      repo.create(sampleInput({ name: 'Parent', path: '/' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ShareNestedPathError);
      const e = err as ShareNestedPathError;
      expect(e.direction).toBe('existing-nested-under-new');
      expect(e.conflictingSharePath).toBe('/media');
    }
  });

  it('test_create_when_input_path_root_slash_and_existing_share_exists_then_throws_ShareNestedPathError', () => {
    // Existing share at root '/' — new non-root share is nested under it.
    repo.create(sampleInput({ name: 'Root', path: '/' }));
    try {
      repo.create(sampleInput({ name: 'Sub', path: '/media' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ShareNestedPathError);
      const e = err as ShareNestedPathError;
      expect(e.direction).toBe('new-nested-under-existing');
      expect(e.conflictingSharePath).toBe('/');
    }
  });

  it('test_create_when_sibling_path_then_no_throw', () => {
    repo.create(sampleInput({ name: 'A', path: '/a' }));
    expect(() => repo.create(sampleInput({ name: 'B', path: '/b' }))).not.toThrow();
    expect(repo.listAll()).toHaveLength(2);
  });

  it('test_create_when_prefix_lookalike_but_not_boundary_then_no_throw', () => {
    // '/media' is NOT a parent of '/mediastorage' because the '/' boundary matters.
    repo.create(sampleInput({ name: 'Library', path: '/media' }));
    expect(() =>
      repo.create(sampleInput({ name: 'Storage', path: '/mediastorage' })),
    ).not.toThrow();
    expect(repo.listAll()).toHaveLength(2);
  });

  it('test_create_when_invalid_input_then_throws_plain_error', () => {
    expect(() => repo.create(sampleInput({ name: '' }))).toThrow(/non-empty/);
    expect(() => repo.create(sampleInput({ path: '' }))).toThrow(/non-empty/);
    expect(() => repo.create(sampleInput({ path: 'relative' }))).toThrow(/absolute/);
    expect(() => repo.create(sampleInput({ min_size_mb: -1 }))).toThrow(/>= 0/);
    expect(() => repo.create(sampleInput({ extensions_csv: '   ' }))).toThrow(/non-empty/);
    expect(() => repo.create(sampleInput({ max_depth: -1 }))).toThrow(/>= 0/);
  });

  it('test_create_when_trailing_slash_then_normalized_before_insert', () => {
    const row = repo.create(sampleInput({ name: 'Library', path: '/media/' }));
    expect(row.path).toBe('/media');
  });
});

describe('shareRepo.update', () => {
  it('test_update_when_partial_patch_name_then_renames_and_bumps_updated_at', async () => {
    const created = repo.create(sampleInput({ name: 'Old', path: '/m' }));
    // Wait a second so updated_at can demonstrably advance.
    await new Promise((r) => setTimeout(r, 1100));
    const updated = repo.update(created.id, { name: 'New' });
    expect(updated?.name).toBe('New');
    expect(updated?.updated_at).toBeGreaterThan(created.updated_at);
    expect(updated?.path).toBe('/m');
  }, 5000);

  it('test_update_when_path_change_introduces_nested_violation_then_throws', () => {
    const a = repo.create(sampleInput({ name: 'A', path: '/a' }));
    repo.create(sampleInput({ name: 'B', path: '/b' }));
    expect(() => repo.update(a.id, { path: '/b/inside' })).toThrow(ShareNestedPathError);
  });

  it('test_update_when_id_missing_then_returns_undefined', () => {
    const result = repo.update(9999, { name: 'Ghost' });
    expect(result).toBeUndefined();
  });

  it('test_update_when_path_change_to_unique_non_nested_then_succeeds', () => {
    const a = repo.create(sampleInput({ name: 'A', path: '/a' }));
    const updated = repo.update(a.id, { path: '/c' });
    expect(updated?.path).toBe('/c');
  });

  it('test_update_when_invalid_min_size_mb_then_throws', () => {
    const a = repo.create(sampleInput({ name: 'A', path: '/a' }));
    expect(() => repo.update(a.id, { min_size_mb: -5 })).toThrow(/>= 0/);
  });
});

describe('shareRepo.remove', () => {
  it('test_remove_when_id_exists_then_deletes_and_returns_true', () => {
    const a = repo.create(sampleInput({ name: 'A', path: '/a' }));
    expect(repo.remove(a.id)).toBe(true);
    expect(repo.getById(a.id)).toBeUndefined();
  });

  it('test_remove_when_id_missing_then_returns_false', () => {
    expect(repo.remove(9999)).toBe(false);
  });

  it('test_remove_when_files_reference_share_then_files_share_id_becomes_null_via_FK_set_null', () => {
    const a = repo.create(sampleInput({ name: 'Library', path: '/media' }));
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, share_id)
       VALUES ('/media/x.mkv', 100, 1, 'h1', 1, ?)`,
    ).run(a.id);
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, share_id)
       VALUES ('/media/y.mkv', 100, 1, 'h2', 1, ?)`,
    ).run(a.id);
    expect(repo.remove(a.id)).toBe(true);
    const rows = db
      .prepare<
        [],
        { path: string; share_id: number | null }
      >('SELECT path, share_id FROM file ORDER BY path')
      .all();
    expect(rows).toEqual([
      { path: '/media/x.mkv', share_id: null },
      { path: '/media/y.mkv', share_id: null },
    ]);
  });
});

describe('shareRepo.listAll / getById / getByPath', () => {
  it('test_listAll_when_multiple_shares_then_ordered_by_id_asc', () => {
    const a = repo.create(sampleInput({ name: 'A', path: '/a' }));
    const b = repo.create(sampleInput({ name: 'B', path: '/b' }));
    const c = repo.create(sampleInput({ name: 'C', path: '/c' }));
    const ids = repo.listAll().map((s) => s.id);
    expect(ids).toEqual([a.id, b.id, c.id]);
  });

  it('test_getById_when_missing_then_returns_undefined', () => {
    expect(repo.getById(9999)).toBeUndefined();
  });

  it('test_getByPath_when_normalized_match_then_returns_row', () => {
    const created = repo.create(sampleInput({ name: 'Library', path: '/media' }));
    expect(repo.getByPath('/media')?.id).toBe(created.id);
    // Trailing slash on lookup normalizes too.
    expect(repo.getByPath('/media/')?.id).toBe(created.id);
  });
});

describe('shareRepo.assertNonNested', () => {
  it('test_assertNonNested_when_excludeId_provided_then_ignores_self', () => {
    const a = repo.create(sampleInput({ name: 'A', path: '/media' }));
    // Re-assert with own path + excludeId=self → no throw (self-exclusion).
    expect(() => repo.assertNonNested({ path: '/media', excludeId: a.id })).not.toThrow();
  });

  it('test_assertNonNested_when_trailing_slash_input_then_normalized_match_still_detected', () => {
    repo.create(sampleInput({ name: 'Library', path: '/media' }));
    expect(() => repo.assertNonNested({ path: '/media/' })).toThrow(ShareNestedPathError);
  });

  it('test_assertNonNested_when_no_existing_shares_then_no_throw', () => {
    expect(() => repo.assertNonNested({ path: '/anything' })).not.toThrow();
  });
});

describe('fileRepo + share_id projection parity', () => {
  it('test_findByPath_when_file_has_share_id_then_row_includes_share_id_field', async () => {
    const a = repo.create(sampleInput({ name: 'Library', path: '/media' }));
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, share_id)
       VALUES ('/media/test.mkv', 100, 1, 'h', 1, ?)`,
    ).run(a.id);
    const { makeFileRepo } = await import('@/src/lib/db/repos/file');
    const fr = makeFileRepo(db);
    const row = fr.findByPath('/media/test.mkv');
    expect(row).toBeDefined();
    expect(row?.share_id).toBe(a.id);
  });

  it('test_findByPath_when_file_has_null_share_id_then_row_share_id_is_null', async () => {
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/other/test.mkv', 100, 1, 'h', 1)`,
    ).run();
    const { makeFileRepo } = await import('@/src/lib/db/repos/file');
    const fr = makeFileRepo(db);
    const row = fr.findByPath('/other/test.mkv');
    expect(row).toBeDefined();
    expect(row?.share_id).toBeNull();
  });
});
