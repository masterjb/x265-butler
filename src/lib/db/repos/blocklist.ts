// 04-02: BlocklistRepo — operator-managed skip-pipeline step 7.
//
// Two row shapes (CHECK-enforced exclusivity):
//   - File-pinned: file_id set, path_pattern null. Survives renames via FK CASCADE.
//   - Pattern: path_pattern set, file_id null. Catches subtrees (e.g. /movies/Samples/*).
//
// audit M1: partial UNIQUE INDEX on file_id WHERE file_id IS NOT NULL —
// concurrent POST race-safety. add() catches SQLITE_CONSTRAINT_UNIQUE and
// returns the existing row (idempotent at SQL layer; mirrors 02-01 audit M4).
//
// audit M2: listAllPatterns() exported for scanner pattern cache. Pure helper
// matchPathInList(filePath, patterns) runs in O(M) without DB calls.
//
// Pattern grammar (research-driven simplification + audit S6 cap + 13-05 mid-path extension):
//   - 0 stars  → exact path match
//   - 1 star   → prefix or suffix only (e.g. /movies/Samples/* OR *.sample.mkv)
//   - 2 stars  → prefix + contains(middle) + suffix (e.g. */Extras/* matches at any depth;
//                /movies/Samples/*.sample.mkv keeps working — empty middle = adjacent stars)
//   - 3+ stars → REJECTED (validation lives in API zod layer; matchPath returns false defensively)
//
// 13-05 (carry-forward P10 2026-05-10 bug): 2-star mid-path patterns like */Extras/*
// previously returned false silently (3-split-parts unhandled). Now matched via
// indexOf(middle, prefix.length) bounded by filePath.length - suffix.length.

import type Database from 'better-sqlite3';
import type { BlocklistRow, BlocklistAddInput, BlocklistReason } from '../schema';
import { withQueryTiming } from '@/src/lib/db/timing';

type Db = InstanceType<typeof Database>;

export interface BlocklistRepo {
  add(input: BlocklistAddInput): BlocklistRow;
  remove(id: number): boolean;
  findById(id: number): BlocklistRow | undefined;
  findByFileId(fileId: number): BlocklistRow | undefined;
  findByPattern(pathPattern: string, reason: BlocklistReason): BlocklistRow | undefined;
  list(opts: { page: number; size: number }): { rows: BlocklistRow[]; total: number };
  listAllPatterns(): BlocklistRow[];
  matchByFileIdOrPath(fileId: number | null, filePath: string): boolean;
  count(): number;
}

// Narrow type-guard for SqliteError.code without depending on a non-exported
// runtime class. better-sqlite3 attaches `.code` strings on its thrown errors.
function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (code.startsWith('SQLITE_CONSTRAINT') &&
      typeof (err as { message?: unknown }).message === 'string' &&
      ((err as { message: string }).message.includes('idx_blocklist_file_id_unique') ||
        (err as { message: string }).message.includes('UNIQUE')))
  );
}

/**
 * Pure pattern-match helper. Exported for scanner pattern cache (audit M2)
 * + reused by repo's per-call matchByFileIdOrPath. NO DB calls.
 *
 * Grammar: leading, trailing, and/or one mid-path wildcard; 3+ stars return
 * false (rejected defensively — API zod should reject before reaching here).
 * Supports 2-star mid-path matching like *\/Extras\/* (since 13-05).
 */
export function matchPathInList(filePath: string, patterns: BlocklistRow[]): boolean {
  for (const p of patterns) {
    if (!p.path_pattern) continue;
    if (matchPath(p.path_pattern, filePath)) return true;
  }
  return false;
}

export function matchPath(pattern: string, filePath: string): boolean {
  // Normalize consecutive stars (**→*): functionally identical in this
  // prefix/suffix matcher because startsWith/endsWith don't treat / specially.
  // Lets operators use the conventional "folder/**" glob without silent misses.
  const normalized = pattern.replace(/\*{2,}/g, '*');
  if (!normalized.includes('*')) return normalized === filePath;
  const parts = normalized.split('*');
  if (parts.length === 2) {
    const [prefix, suffix] = parts;
    return filePath.startsWith(prefix) && filePath.endsWith(suffix);
  }
  if (parts.length === 3) {
    const [prefix, middle, suffix] = parts;
    if (!filePath.startsWith(prefix)) return false;
    if (!filePath.endsWith(suffix)) return false;
    // Overlap-guard: prefix + suffix may not exceed filePath length, otherwise
    // a same-character could be claimed by both startsWith and endsWith.
    if (prefix.length + suffix.length > filePath.length) return false;
    // Middle must appear AFTER prefix and END BEFORE suffix-start; empty middle
    // is legal (e.g. pattern `**` post-normalize becomes `*`, never lands here).
    const searchStart = prefix.length;
    const searchEndLimit = filePath.length - suffix.length;
    const idx = filePath.indexOf(middle, searchStart);
    return idx !== -1 && idx + middle.length <= searchEndLimit;
  }
  // 3+ stars (4+ split-parts) → defensive false; API zod caps at ≤2 stars (audit S6).
  return false;
}

export function makeBlocklistRepo(db: Db): BlocklistRepo {
  const insertStmt = db.prepare<[number | null, string | null, string], void>(
    `INSERT INTO blocklist_entry (file_id, path_pattern, reason) VALUES (?, ?, ?)`,
  );
  const findByIdStmt = db.prepare<[number], BlocklistRow>(
    'SELECT * FROM blocklist_entry WHERE id = ?',
  );
  const findByFileIdStmt = db.prepare<[number], BlocklistRow>(
    'SELECT * FROM blocklist_entry WHERE file_id = ?',
  );
  const findByPatternStmt = db.prepare<[string, string], BlocklistRow>(
    'SELECT * FROM blocklist_entry WHERE path_pattern = ? AND reason = ? AND file_id IS NULL',
  );
  const removeStmt = db.prepare<[number], void>('DELETE FROM blocklist_entry WHERE id = ?');
  const listStmt = db.prepare<[number, number], BlocklistRow>(
    'SELECT * FROM blocklist_entry ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
  );
  const countStmt = db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM blocklist_entry');
  const listAllPatternsStmt = db.prepare<[], BlocklistRow>(
    'SELECT * FROM blocklist_entry WHERE path_pattern IS NOT NULL',
  );
  const listForMatchStmt = db.prepare<[number | null], BlocklistRow>(
    'SELECT * FROM blocklist_entry WHERE (file_id = ?) OR (path_pattern IS NOT NULL)',
  );

  function findById(id: number): BlocklistRow | undefined {
    return findByIdStmt.get(id);
  }

  function findByFileId(fileId: number): BlocklistRow | undefined {
    return findByFileIdStmt.get(fileId);
  }

  function findByPattern(pathPattern: string, reason: BlocklistReason): BlocklistRow | undefined {
    return findByPatternStmt.get(pathPattern, reason);
  }

  function add(input: BlocklistAddInput): BlocklistRow {
    const reason: BlocklistReason = input.reason ?? 'operator';
    const fileId = input.file_id ?? null;
    const pattern = input.path_pattern ?? null;

    // Idempotency for file-pinned (audit M1): if entry exists, return it.
    if (fileId !== null) {
      const existing = findByFileId(fileId);
      if (existing) return existing;
    }

    try {
      const result = insertStmt.run(fileId, pattern, reason);
      const row = findByIdStmt.get(Number(result.lastInsertRowid));
      if (!row) throw new Error('blocklistRepo.add: insert returned no row');
      return row;
    } catch (err) {
      // audit M1: race condition — another POST inserted concurrently between
      // our existence check and INSERT. Re-fetch + return existing row.
      if (isUniqueConstraintError(err) && fileId !== null) {
        const existing = findByFileId(fileId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  function remove(id: number): boolean {
    const result = removeStmt.run(id);
    return result.changes === 1;
  }

  function list(opts: { page: number; size: number }): { rows: BlocklistRow[]; total: number } {
    const safePage = Math.max(1, Math.floor(opts.page));
    const safeSize = Math.min(Math.max(1, Math.floor(opts.size)), 200);
    const offset = (safePage - 1) * safeSize;
    const rows = listStmt.all(safeSize, offset);
    const total = countStmt.get()?.n ?? 0;
    return { rows, total };
  }

  function listAllPatterns(): BlocklistRow[] {
    return withQueryTiming('blocklistRepo.listAllPatterns', () => listAllPatternsStmt.all());
  }

  function matchByFileIdOrPath(fileId: number | null, filePath: string): boolean {
    const candidates = listForMatchStmt.all(fileId);
    for (const c of candidates) {
      if (c.file_id !== null && c.file_id === fileId) return true;
      if (c.path_pattern !== null && matchPath(c.path_pattern, filePath)) return true;
    }
    return false;
  }

  function count(): number {
    return countStmt.get()?.n ?? 0;
  }

  return {
    add,
    remove,
    findById,
    findByFileId,
    findByPattern,
    list,
    listAllPatterns,
    matchByFileIdOrPath,
    count,
  };
}
