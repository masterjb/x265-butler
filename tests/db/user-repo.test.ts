/*
 * 05-01 Task 1: UserRepo CRUD + UNIQUE constraint behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { isUniqueConstraintError, makeUserRepo, type UserRepo } from '@/src/lib/db/repos/user';

let db: InstanceType<typeof Database>;
let repo: UserRepo;

const VALID_HASH = '$2a$12$tNrqPrdotbJVQfNXm9uS5OumHgHtSxPa.QmH8MMuaTsaEYn/DIORK';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  repo = makeUserRepo(db);
});

afterEach(() => {
  db.close();
});

describe('UserRepo — create', () => {
  it('test_create_when_first_user_then_returns_row_with_id_1', () => {
    const row = repo.create({ username: 'admin', password_hash: VALID_HASH });
    expect(row.id).toBe(1);
    expect(row.username).toBe('admin');
    expect(row.password_hash).toBe(VALID_HASH);
    expect(row.last_login_at).toBeNull();
  });

  it('test_create_when_duplicate_username_then_throws_unique_constraint', () => {
    repo.create({ username: 'admin', password_hash: VALID_HASH });
    let threw = false;
    try {
      repo.create({ username: 'admin', password_hash: VALID_HASH });
    } catch (err) {
      threw = true;
      expect(isUniqueConstraintError(err)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it('test_create_when_username_too_short_then_throws_check_constraint', () => {
    let threw = false;
    try {
      repo.create({ username: 'ab', password_hash: VALID_HASH });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('test_create_when_password_hash_wrong_length_then_throws_check_constraint', () => {
    let threw = false;
    try {
      repo.create({ username: 'admin', password_hash: 'too-short' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('UserRepo — read', () => {
  it('test_findByUsername_when_exists_then_returns_row', () => {
    repo.create({ username: 'admin', password_hash: VALID_HASH });
    const row = repo.findByUsername('admin');
    expect(row?.username).toBe('admin');
  });

  it('test_findByUsername_when_missing_then_undefined', () => {
    expect(repo.findByUsername('nobody')).toBeUndefined();
  });

  it('test_count_when_empty_then_zero', () => {
    expect(repo.count()).toBe(0);
  });

  it('test_count_when_one_user_then_1', () => {
    repo.create({ username: 'admin', password_hash: VALID_HASH });
    expect(repo.count()).toBe(1);
  });
});

describe('UserRepo — mutations', () => {
  it('test_setLastLoginAt_when_called_then_updates_row', () => {
    const row = repo.create({ username: 'admin', password_hash: VALID_HASH });
    repo.setLastLoginAt(row.id, 1_700_000_000);
    const refreshed = repo.findById(row.id);
    expect(refreshed?.last_login_at).toBe(1_700_000_000);
  });

  it('test_updatePassword_when_called_then_changes_hash', () => {
    const row = repo.create({ username: 'admin', password_hash: VALID_HASH });
    const newHash = '$2a$12$' + 'b'.repeat(53);
    repo.updatePassword(row.id, newHash);
    const refreshed = repo.findById(row.id);
    expect(refreshed?.password_hash).toBe(newHash);
  });

  it('test_deleteAll_when_users_present_then_removes_all_and_returns_count', () => {
    repo.create({ username: 'admin', password_hash: VALID_HASH });
    expect(repo.deleteAll()).toBe(1);
    expect(repo.count()).toBe(0);
  });
});
