/*
 * 28-03 (P8) AC-5 / AC-5b / AC-5c: repo-layer getAll() cache.
 *
 * Pins:
 *   - getAll() runs the SELECT at most once between writes (cache hit)
 *   - set()/delete() invalidate so the very next getAll() is exact
 *   - the cached record is frozen (MH-3) — a consumer mutation cannot poison it
 *   - a db swap (singleton _settingRepo reset) yields a fresh cache, no bleed (SR-1)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';
import { settingRepo, __forTests_setDb, __forTests_resetDb } from '@/src/lib/db';

type Db = InstanceType<typeof Database>;

function freshDb(): Db {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

// Wrap db.prepare so we can count executions of the `SELECT * FROM setting`
// statement that backs getAll().
function instrument(db: Db): { repo: SettingRepo; allCalls: () => number } {
  const realPrepare = db.prepare.bind(db);
  let calls = 0;
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const stmt = realPrepare(sql);
    if (typeof sql === 'string' && sql.includes('SELECT * FROM setting')) {
      const realAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        calls++;
        return realAll(...args);
      }) as typeof stmt.all;
    }
    return stmt;
  }) as typeof db.prepare);
  const repo = makeSettingRepo(db);
  return { repo, allCalls: () => calls };
}

describe('SettingRepo getAll() cache (28-03 P8)', () => {
  let db: Db;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('test_a_two_getAll_without_write_runs_select_once', () => {
    const { repo, allCalls } = instrument(db);
    repo.getAll();
    repo.getAll();
    repo.getAll();
    expect(allCalls()).toBe(1);
  });

  it('test_b_set_then_getAll_reflects_new_value', () => {
    const { repo, allCalls } = instrument(db);
    repo.getAll(); // prime cache (call 1)
    repo.set('encoder', 'nvenc');
    const after = repo.getAll(); // cache invalidated → call 2
    expect(after.encoder).toBe('nvenc');
    expect(allCalls()).toBe(2);
  });

  it('test_c_delete_then_getAll_drops_key', () => {
    const { repo } = instrument(db);
    repo.set('custom_pref', 'on');
    expect(repo.getAll().custom_pref).toBe('on');
    repo.delete('custom_pref');
    expect(repo.getAll().custom_pref).toBeUndefined();
  });

  it('test_d_returned_object_identity_stable_on_cache_hit', () => {
    const { repo } = instrument(db);
    const first = repo.getAll();
    const second = repo.getAll();
    expect(second).toBe(first);
  });

  it('test_e_cached_record_is_frozen_and_not_poisonable', () => {
    const { repo } = instrument(db);
    const snap = repo.getAll();
    expect(Object.isFrozen(snap)).toBe(true);
    // a mutation attempt throws in strict mode (vitest ESM) / is a no-op —
    // either way it must NOT corrupt a subsequent getAll().
    try {
      (snap as Record<string, string>).encoder = 'TAMPERED';
    } catch {
      // strict-mode TypeError on frozen object — expected
    }
    expect(repo.getAll().encoder).not.toBe('TAMPERED');
  });

  it('test_f_db_swap_resets_singleton_repo_no_cache_bleed', () => {
    const db1 = freshDb();
    __forTests_setDb(db1);
    settingRepo().set('sr1_probe', 'old');
    expect(settingRepo().getAll().sr1_probe).toBe('old'); // caches

    const db2 = freshDb();
    __forTests_setDb(db2); // nulls _settingRepo → fresh repo + fresh cache
    expect(settingRepo().getAll().sr1_probe).toBeUndefined();

    __forTests_resetDb();
  });
});
