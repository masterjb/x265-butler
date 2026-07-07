// 05-01: UserRepo — single-user auth.
// Phase 5 Plan 05-01 (Auth Backend Foundation).
//
// Factory pattern matches repos/blocklist.ts. SQLITE_CONSTRAINT_UNIQUE on
// concurrent setup is mapped by the API handler to 409 setup_already_completed
// (audit M3 race-fix; see app/api/auth/setup/route.ts).

import type Database from 'better-sqlite3';
import type { UserRow, UserCreateInput } from '../schema';

type Db = InstanceType<typeof Database>;

export interface UserRepo {
  create(input: UserCreateInput): UserRow;
  findByUsername(username: string): UserRow | undefined;
  findById(id: number): UserRow | undefined;
  updatePassword(id: number, passwordHash: string): void;
  setLastLoginAt(id: number, ts: number): void;
  count(): number;
  deleteAll(): number;
}

export function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code.startsWith('SQLITE_CONSTRAINT');
}

export function makeUserRepo(db: Db): UserRepo {
  const insertStmt = db.prepare<[string, string], void>(
    'INSERT INTO user (username, password_hash) VALUES (?, ?)',
  );
  const findByUsernameStmt = db.prepare<[string], UserRow>('SELECT * FROM user WHERE username = ?');
  const findByIdStmt = db.prepare<[number], UserRow>('SELECT * FROM user WHERE id = ?');
  const updatePasswordStmt = db.prepare<[string, number], void>(
    'UPDATE user SET password_hash = ? WHERE id = ?',
  );
  const setLastLoginStmt = db.prepare<[number, number], void>(
    'UPDATE user SET last_login_at = ? WHERE id = ?',
  );
  const countStmt = db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM user');
  const deleteAllStmt = db.prepare<[], void>('DELETE FROM user');

  return {
    create(input: UserCreateInput): UserRow {
      const result = insertStmt.run(input.username, input.password_hash);
      const id = Number(result.lastInsertRowid);
      const row = findByIdStmt.get(id);
      if (!row) throw new Error(`UserRepo.create: row ${id} not found post-insert`);
      return row;
    },

    findByUsername(username: string): UserRow | undefined {
      return findByUsernameStmt.get(username);
    },

    findById(id: number): UserRow | undefined {
      return findByIdStmt.get(id);
    },

    updatePassword(id: number, passwordHash: string): void {
      updatePasswordStmt.run(passwordHash, id);
    },

    setLastLoginAt(id: number, ts: number): void {
      setLastLoginStmt.run(ts, id);
    },

    count(): number {
      return countStmt.get()?.n ?? 0;
    },

    deleteAll(): number {
      const result = deleteAllStmt.run();
      return Number(result.changes);
    },
  };
}
