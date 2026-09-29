// 14-01: ShareRepo — operator-managed multi-share definitions.
//
// Pattern mirrors setting.ts + blocklist.ts (singleton factory + prepared
// statements). NO zod here — repo accepts validated input; zod boundary
// lives at 14-04 API layer.
//
// Nested-path invariant (audit-fix:M2 root-special-case): for any pair of
// existing/new shares (s, input), neither path may contain the other as an
// ancestor. Plain `startsWith(s.path + '/')` fails for s.path === '/' because
// '/media'.startsWith('//') = false; root is handled via explicit branches.
//
// FK ON DELETE SET NULL on file.share_id: remove(id) lets SQLite SET NULL
// orphaned file-rows automatically (PRAGMA foreign_keys=ON applied in
// db/index.ts:79). No manual UPDATE — that would race the scan-loop.

import type Database from 'better-sqlite3';
import type { ShareRow, ShareCreateInput, ShareUpdateInput } from '../schema';
import { withQueryTiming } from '@/src/lib/db/timing';

type Db = InstanceType<typeof Database>;

export class ShareNestedPathError extends Error {
  readonly conflictingShareName: string;
  readonly conflictingSharePath: string;
  readonly direction: 'new-nested-under-existing' | 'existing-nested-under-new';
  constructor(
    msg: string,
    conflict: { name: string; path: string },
    direction: 'new-nested-under-existing' | 'existing-nested-under-new',
  ) {
    super(msg);
    this.name = 'ShareNestedPathError';
    this.conflictingShareName = conflict.name;
    this.conflictingSharePath = conflict.path;
    this.direction = direction;
  }
}

export interface ShareRepo {
  listAll(): ShareRow[];
  getById(id: number): ShareRow | undefined;
  getByPath(path: string): ShareRow | undefined;
  create(input: ShareCreateInput): ShareRow;
  update(id: number, patch: ShareUpdateInput): ShareRow | undefined;
  remove(id: number): boolean;
  assertNonNested(input: { path: string; excludeId?: number }): void;
}

function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('shareRepo: path must be a non-empty string');
  }
  if (!input.startsWith('/')) {
    throw new Error(`shareRepo: path must be absolute (start with /), got '${input}'`);
  }
  if (input === '/') return '/';
  return input.endsWith('/') ? input.slice(0, -1) : input;
}

function validateCreateInput(input: ShareCreateInput): ShareCreateInput {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('shareRepo: name must be a non-empty string');
  }
  const path = normalizePath(input.path);
  if (typeof input.min_size_mb !== 'number' || input.min_size_mb < 0) {
    throw new Error('shareRepo: min_size_mb must be >= 0');
  }
  if (typeof input.extensions_csv !== 'string' || input.extensions_csv.trim().length === 0) {
    throw new Error('shareRepo: extensions_csv must be non-empty after trim');
  }
  if (input.max_depth !== null && (typeof input.max_depth !== 'number' || input.max_depth < 0)) {
    throw new Error('shareRepo: max_depth must be null or >= 0');
  }
  return { ...input, name: input.name.trim(), path, extensions_csv: input.extensions_csv.trim() };
}

export function makeShareRepo(db: Db): ShareRepo {
  const listAllStmt = db.prepare<[], ShareRow>('SELECT * FROM shares ORDER BY id ASC');
  const getByIdStmt = db.prepare<[number], ShareRow>('SELECT * FROM shares WHERE id = ?');
  const getByPathStmt = db.prepare<[string], ShareRow>('SELECT * FROM shares WHERE path = ?');
  const insertStmt = db.prepare<[string, string, number, string, number | null], ShareRow>(
    `INSERT INTO shares (name, path, min_size_mb, extensions_csv, max_depth)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  );
  const deleteStmt = db.prepare<[number], void>('DELETE FROM shares WHERE id = ?');

  function assertNonNested(input: { path: string; excludeId?: number }): void {
    const inputPath = normalizePath(input.path);
    const existing = listAllStmt.all();
    for (const s of existing) {
      if (input.excludeId !== undefined && s.id === input.excludeId) continue;
      if (s.path === inputPath) {
        throw new ShareNestedPathError(
          `path '${inputPath}' is nested under existing share '${s.name}' (same path)`,
          s,
          'new-nested-under-existing',
        );
      }
      // M2-fix: existing share at root '/' is parent of every non-root input.
      if (s.path === '/' && inputPath !== '/') {
        throw new ShareNestedPathError(
          `path '${inputPath}' is nested under existing share '${s.name}' at root '/'`,
          s,
          'new-nested-under-existing',
        );
      }
      // M2-fix: new share at root '/' swallows every existing non-root share.
      if (inputPath === '/' && s.path !== '/') {
        throw new ShareNestedPathError(
          `existing share '${s.name}' at '${s.path}' is nested under new root path '/'`,
          s,
          'existing-nested-under-new',
        );
      }
      if (inputPath.startsWith(s.path + '/')) {
        throw new ShareNestedPathError(
          `path '${inputPath}' is nested under existing share '${s.name}' at '${s.path}'`,
          s,
          'new-nested-under-existing',
        );
      }
      if (s.path.startsWith(inputPath + '/')) {
        throw new ShareNestedPathError(
          `existing share '${s.name}' at '${s.path}' is nested under new path '${inputPath}'`,
          s,
          'existing-nested-under-new',
        );
      }
    }
  }

  return {
    listAll(): ShareRow[] {
      return withQueryTiming('shareRepo.listAll', () => listAllStmt.all());
    },

    getById(id: number): ShareRow | undefined {
      return getByIdStmt.get(id);
    },

    getByPath(path: string): ShareRow | undefined {
      return getByPathStmt.get(normalizePath(path));
    },

    create(input: ShareCreateInput): ShareRow {
      const validated = validateCreateInput(input);
      assertNonNested({ path: validated.path });
      const row = insertStmt.get(
        validated.name,
        validated.path,
        validated.min_size_mb,
        validated.extensions_csv,
        validated.max_depth,
      );
      if (!row) throw new Error('shareRepo.create: INSERT returned no row');
      return row;
    },

    update(id: number, patch: ShareUpdateInput): ShareRow | undefined {
      const current = getByIdStmt.get(id);
      if (!current) return undefined;

      const next: ShareRow = { ...current };
      if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || patch.name.trim().length === 0) {
          throw new Error('shareRepo: name must be a non-empty string');
        }
        next.name = patch.name.trim();
      }
      if (patch.path !== undefined) {
        next.path = normalizePath(patch.path);
        assertNonNested({ path: next.path, excludeId: id });
      }
      if (patch.min_size_mb !== undefined) {
        if (typeof patch.min_size_mb !== 'number' || patch.min_size_mb < 0) {
          throw new Error('shareRepo: min_size_mb must be >= 0');
        }
        next.min_size_mb = patch.min_size_mb;
      }
      if (patch.extensions_csv !== undefined) {
        if (typeof patch.extensions_csv !== 'string' || patch.extensions_csv.trim().length === 0) {
          throw new Error('shareRepo: extensions_csv must be non-empty after trim');
        }
        next.extensions_csv = patch.extensions_csv.trim();
      }
      if (patch.max_depth !== undefined) {
        if (
          patch.max_depth !== null &&
          (typeof patch.max_depth !== 'number' || patch.max_depth < 0)
        ) {
          throw new Error('shareRepo: max_depth must be null or >= 0');
        }
        next.max_depth = patch.max_depth;
      }

      const updateStmt = db.prepare<
        [string, string, number, string, number | null, number],
        ShareRow
      >(
        `UPDATE shares
         SET name = ?, path = ?, min_size_mb = ?, extensions_csv = ?, max_depth = ?,
             updated_at = CAST(strftime('%s','now') AS INTEGER)
         WHERE id = ?
         RETURNING *`,
      );
      const row = updateStmt.get(
        next.name,
        next.path,
        next.min_size_mb,
        next.extensions_csv,
        next.max_depth,
        id,
      );
      return row;
    },

    remove(id: number): boolean {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    assertNonNested,
  };
}
